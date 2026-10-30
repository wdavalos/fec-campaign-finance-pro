const { Actor } = require('apify');

const BASE = 'https://api.open.fec.gov/v1';

async function fetchOnce(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 40000);
    try {
        const resp = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
        const code = resp.status;
        if (code === 429 || code === 502 || code === 503 || code === 504) {
            const err = new Error('FEC ' + code);
            err.httpCode = code;
            throw err;
        }
        if (!resp.ok) {
            const err = new Error('FEC ' + code);
            err.httpCode = code;
            throw err;
        }
        return await resp.json();
    } finally {
        clearTimeout(timer);
    }
}

async function fetchJson(url, { attempts = 4 } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fetchOnce(url);
        } catch (err) {
            lastErr = err;
            const code = err.httpCode || 0;
            // 429 rate limit, gateway 5xx and network drops: back off and retry.
            if (code === 429 || code === 502 || code === 503 || code === 504 || code === 0) {
                await new Promise((r) => setTimeout(r, (i + 1) * 2000));
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

function add(params, key, val) {
    if (val === undefined || val === null) return;
    const s = String(val).trim();
    if (!s) return;
    if (key === 'minAmount' && Number(val) <= 0) return;
    params.append(key, s);
}

function buildUrl(input, apiKey, perPage, page) {
    const p = new URLSearchParams();
    p.append('api_key', apiKey);
    p.append('per_page', String(perPage));
    p.append('page', String(page));
    const type = input.searchType || 'candidates';

    if (type === 'candidates') {
        add(p, 'q', input.query);
        add(p, 'office', input.office);
        add(p, 'state', input.state);
        add(p, 'party', input.party);
        return `${BASE}/candidates/search/?${p.toString()}`;
    }
    if (type === 'committees') {
        add(p, 'q', input.query);
        add(p, 'state', input.state);
        add(p, 'party', input.party);
        return `${BASE}/committees/?${p.toString()}`;
    }
    const period = input.twoYearPeriod || 2026;
    p.append('two_year_transaction_period', String(period));
    add(p, 'min_date', input.dateFrom);
    add(p, 'max_date', input.dateTo);
    if (type === 'contributions') {
        add(p, 'committee_id', input.committeeId);
        add(p, 'contributor_name', input.query);
        add(p, 'min_amount', input.minAmount);
        return `${BASE}/schedules/schedule_a/?${p.toString()}`;
    }
    // expenditures
    add(p, 'committee_id', input.committeeId);
    add(p, 'candidate_id', input.candidateId);
    add(p, 'payee_name', input.query);
    return `${BASE}/schedules/schedule_e/?${p.toString()}`;
}

function mapRow(input, r) {
    const type = input.searchType || 'candidates';
    if (type === 'candidates') {
        return {
            candidateId: r.candidate_id || '',
            name: r.name || '',
            party: r.party_full || r.party || '',
            office: r.office_full || r.office || '',
            state: r.state || '',
            district: r.district || '',
            lastCycle: r.cycles && r.cycles.length ? r.cycles[r.cycles.length - 1] : '',
            hasRaisedFunds: r.has_raised_funds === true,
            incumbentStatus: r.incumbent_challenge_full || '',
            firstFiled: r.first_file_date || '',
            lastFiled: r.last_file_date || '',
            committeeIds: (r.principal_committees || []).map((c) => c.committee_id).slice(0, 5),
            fecLink: r.candidate_id ? `https://www.fec.gov/data/candidate/${r.candidate_id}/` : '',
            searchType: 'candidates',
        };
    }
    if (type === 'committees') {
        return {
            committeeId: r.committee_id || '',
            name: r.name || r.affiliated_committee_name || '',
            designation: r.designation_full || r.designation || '',
            type: r.committee_type_full || r.committee_type || '',
            state: r.state || '',
            party: r.party_full || r.party || '',
            treasurer: r.treasurer_name || '',
            lastCycle: r.cycles && r.cycles.length ? r.cycles[r.cycles.length - 1] : '',
            firstFiled: r.first_file_date || '',
            linkedCandidates: (r.candidate_ids || []).slice(0, 5),
            fecLink: r.committee_id ? `https://www.fec.gov/data/committee/${r.committee_id}/` : '',
            searchType: 'committees',
        };
    }
    if (type === 'contributions') {
        return {
            contributor: r.contributor_name || [r.contributor_first_name, r.contributor_middle_name, r.contributor_last_name].filter(Boolean).join(' '),
            employer: r.contributor_employer || '',
            occupation: r.contributor_occupation || '',
            city: r.contributor_city || '',
            state: r.contributor_state || '',
            amount: r.contribution_receipt_amount,
            receiptDate: r.contribution_receipt_date || '',
            aggregateYtd: r.contributor_aggregate_ytd,
            committeeId: r.committee_id || '',
            committeeName: (r.committee && r.committee.name) || r.committee_name || '',
            candidateName: r.candidate_name || '',
            pdfUrl: r.pdf_url || '',
            searchType: 'contributions',
        };
    }
    // expenditures
    return {
        payee: r.payee_name || '',
        amount: r.expenditure_amount,
        expenditureDate: r.expenditure_date || '',
        description: r.expenditure_description || '',
        committeeId: r.committee_id || '',
        committeeName: (r.committee && r.committee.name) || r.filer_name || '',
        candidateName: r.candidate_name || '',
        candidateId: r.candidate_id || '',
        supportOrOppose: r.support_oppose_indicator || '',
        filingNumber: r.file_number || '',
        pdfUrl: r.pdf_url || '',
        searchType: 'expenditures',
    };
}

Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const apiKey = input.apiKey || 'DEMO_KEY';
    const type = input.searchType || 'candidates';
    const maxItems = Math.min(Number(input.maxItems) > 0 ? Number(input.maxItems) : 10, 5000);
    const perPage = Math.min(maxItems, 100);

    if ((type === 'contributions' || type === 'expenditures') && !input.committeeId && !input.query && !input.candidateId) {
        await Actor.pushData([{
            status: 'ZERO_RESULTS',
            reason: 'Money queries (contributions/expenditures) need at least one filter: committeeId, query, or candidateId. Unfiltered Schedule A/E pulls time out on the FEC side. This hint row is the only billed item.',
        }]);
        return;
    }

    let pushed = 0;
    let page = 1;
    let lastCount = null;
    let sawError = false;

    while (pushed < maxItems) {
        const url = buildUrl(input, apiKey, perPage, page);
        let data;
        try {
            data = await fetchJson(url);
        } catch (err) {
            sawError = true;
            const code = err && err.httpCode ? err.httpCode : 0;
            await Actor.pushData([{
                status: 'ERROR',
                httpStatus: code,
                reason: code === 429
                    ? 'FEC rate limit hit (DEMO_KEY is shared and heavily capped). Get a free personal API key at https://api.data.gov/signup/ and put it in the apiKey input for reliable volume.'
                    : `FEC request failed (HTTP ${code || 'network'}). Retry, or narrow your filters (a committee ID plus a date window is the fastest query).`,
            }]);
            break;
        }

        const results = data && data.results ? data.results : [];
        if (lastCount === null && data && data.pagination) lastCount = data.pagination.count;
        if (!results.length) break;
        for (const r of results) {
            if (pushed >= maxItems) break;
            await Actor.pushData([mapRow(input, r)]);
            pushed += 1;
        }
        const totalPages = data && data.pagination ? data.pagination.pages : 1;
        if (page >= totalPages) break;
        page += 1;
    }

    if (pushed === 0 && !sawError) {
        await Actor.pushData([{
            status: 'ZERO_RESULTS',
            reason: 'The FEC returned no rows for these filters. Loosen the query, widen the date window, or check the two-year transaction period. This hint row is the only billed item.',
        }]);
    }

    await Actor.setValue('OUTPUT_INFO', {
        searchType: type,
        pushed,
        fecTotalMatching: lastCount,
    });
});
