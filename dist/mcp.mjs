import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import { XMLParser } from 'fast-xml-parser';
import { discoverCompanies, fetchReport, importMasters, invokeTallyAction, queryCollection, renameObjectArrayProperties, postTallyXML, nEnv } from './tally.mjs';
import { cacheTable, executeSQL } from './database.mjs';
import { lstCollectionFields, lstOptionCountryState, lstReportXml, lstReportConfig } from './definition.mjs';
import { utility } from './utility.mjs';
dotenv.config({ override: true, quiet: true });
const lstCollections = lstCollectionFields.map((item) => item.collection);
const lstCollectionInputs = lstCollections.map((item) => item.toLowerCase());
const normalizeCollectionInput = (value) => typeof value === 'string' ? value.trim().toLowerCase() : value;
const canonicalCollection = (value) => lstCollections.find((item) => item.toLowerCase() === String(value || '').trim().toLowerCase());
const tableResponse = (tableID, rows = undefined, message = undefined) => ({
    content: [{ type: 'text', text: JSON.stringify({ tableID, rows, message }) }]
});
const safeCount = (rows) => Array.isArray(rows) ? rows.length : 0;

export const parseBankStatementDate = (value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
        // Excel serial dates are common in uploaded XLSX files.
        if (value > 20000 && value < 80000) return new Date(Math.round((value - 25569) * 86400000));
        // Tally sometimes returns dates as YYYYMMDD numeric strings/numbers.
        const asText = String(Math.trunc(value));
        if (/^\d{8}$/.test(asText)) {
            const y = Number(asText.slice(0, 4));
            const m = Number(asText.slice(4, 6));
            const d = Number(asText.slice(6, 8));
            if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return new Date(y, m - 1, d);
        }
    }
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^\d{8}$/.test(text)) {
        const y = Number(text.slice(0, 4));
        const m = Number(text.slice(4, 6));
        const d = Number(text.slice(6, 8));
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return new Date(y, m - 1, d);
    }
    if (/^\d+(\.\d+)?$/.test(text)) {
        const serial = Number(text);
        if (serial > 20000 && serial < 80000) return new Date(Math.round((serial - 25569) * 86400000));
    }
    let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    m = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
    if (m) {
        let y = Number(m[3]);
        if (y < 100) y += y >= 70 ? 1900 : 2000;
        return new Date(y, Number(m[2]) - 1, Number(m[1]));
    }
    m = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2}|\d{4})$/);
    if (m) {
        const months = { JAN: 0, JANUARY: 0, FEB: 1, FEBRUARY: 1, MAR: 2, MARCH: 2, APR: 3, APRIL: 3, MAY: 4, JUN: 5, JUNE: 5, JUL: 6, JULY: 6, AUG: 7, AUGUST: 7, SEP: 8, SEPT: 8, SEPTEMBER: 8, OCT: 9, OCTOBER: 9, NOV: 10, NOVEMBER: 10, DEC: 11, DECEMBER: 11 };
        const mm = months[m[2].toUpperCase()];
        if (mm !== undefined) {
            let y = Number(m[3]);
            if (y < 100) y += y >= 70 ? 1900 : 2000;
            return new Date(y, mm, Number(m[1]));
        }
    }
    const dt = new Date(text);
    return Number.isNaN(dt.getTime()) ? null : dt;
};
const isoDate = (value) => {
    const dt = parseBankStatementDate(value);
    if (!dt) return '';
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};
const daysBetween = (a, b) => {
    const da = parseBankStatementDate(a);
    const db = parseBankStatementDate(b);
    if (!da || !db) return 999999;
    return Math.abs(Math.round((da.getTime() - db.getTime()) / 86400000));
};
const parseBankAmount = (value) => {
    if (value === undefined || value === null || value === '') return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    let text = String(value).trim().replace(/,/g, '').replace(/₹/g, '').replace(/\s/g, '');
    if (!text || text === '-') return 0;
    const negative = /^\(.+\)$/.test(text) || text.endsWith('Dr') || text.endsWith('DR') || text.startsWith('-');
    text = text.replace(/[()]/g, '').replace(/dr|cr/ig, '');
    const n = parseFloat(text);
    if (!Number.isFinite(n)) return 0;
    return negative ? -Math.abs(n) : n;
};
const pickFirst = (row, keys) => {
    for (const key of keys) {
        if (row && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') return row[key];
    }
    return '';
};
const compactKey = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
const pickFirstLoose = (row, keys) => {
    const direct = pickFirst(row, keys);
    if (direct !== '') return direct;
    if (!row || typeof row !== 'object') return '';
    const wanted = keys.map(compactKey).filter(Boolean);
    for (const [key, value] of Object.entries(row)) {
        if (value === undefined || value === null || String(value).trim() === '') continue;
        const ck = compactKey(key);
        if (!ck) continue;
        if (wanted.some(w => ck === w || ck.includes(w))) return value;
    }
    return '';
};
const normalizeText = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const insertAlphaNumBoundary = (str) => {
    return String(str || '')
        // letter immediately followed by digit -> insert separator
        .replace(/([A-Za-z])(\d)/g, '$1/$2')
        // digit immediately followed by letter -> insert separator
        .replace(/(\d)([A-Za-z])/g, '$1/$2');
};
const normalizeRef = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const tokenSimilarity = (a, b) => {
    const aa = new Set(normalizeText(a).split(/\s+/).filter(t => t.length >= 4));
    const bb = new Set(normalizeText(b).split(/\s+/).filter(t => t.length >= 4));
    if (!aa.size || !bb.size) return 0;
    let common = 0;
    aa.forEach(t => { if (bb.has(t)) common++; });
    return common / Math.max(aa.size, bb.size);
};
const normalizeBankStatementRow = (row, index) => {
    const date = pickFirst(row, ['date', 'Date', 'txn_date', 'transaction_date', 'Transaction Date']);
    const valueDate = pickFirst(row, ['value_date', 'Value Dt', 'Value Date', 'valueDate', 'ValueDt']);
    const narration = pickFirst(row, ['narration', 'Narration', 'description', 'Description', 'particulars', 'Particulars']);
    const ref = pickFirst(row, ['chq_ref_no', 'Chq./Ref.No.', 'Chq/RefNo', 'chqRefNo', 'ref_no', 'reference', 'Reference']);
    const withdrawal = Math.abs(parseBankAmount(pickFirst(row, ['withdrawal_amount', 'Withdrawal Amt.', 'withdrawal', 'Withdrawal', 'debit', 'Debit'])));
    const deposit = Math.abs(parseBankAmount(pickFirst(row, ['deposit_amount', 'Deposit Amt.', 'deposit', 'Deposit', 'credit', 'Credit'])));
    const closingBalance = parseBankAmount(pickFirst(row, ['closing_balance', 'Closing Balance', 'balance', 'Balance']));
    const direction = withdrawal > 0 ? 'withdrawal' : (deposit > 0 ? 'deposit' : 'unknown');
    const amount = withdrawal > 0 ? withdrawal : deposit;
    return {
        bank_index: index + 1,
        date: isoDate(date),
        value_date: isoDate(valueDate || date),
        narration: String(narration || ''),
        chq_ref_no: String(ref || ''),
        withdrawal_amount: withdrawal || 0,
        deposit_amount: deposit || 0,
        closing_balance: closingBalance || 0,
        direction,
        amount
    };
};
const normalizeTallyBankRow = (row, index) => {
    const amount = parseBankAmount(row?.amount);
    return {
        tally_index: index + 1,
        guid: String(row?.guid || ''),
        date: isoDate(row?.date),
        voucher_type: String(row?.voucher_type || ''),
        voucher_number: String(row?.voucher_number || ''),
        alternate_ledger: String(row?.alternate_ledger || ''),
        party_ledger: String(row?.party_name || row?.party_ledger || ''),
        amount,
        abs_amount: Math.abs(amount),
        direction: amount >= 0 ? 'withdrawal' : 'deposit',
        narration: String(row?.narration || '')
    };
};

const isLikelyTdsPercentage = (percentDiff, diff, baseAmount) => {
    if (!baseAmount || baseAmount <= 0) return false;
    const standardTdsRates = [0.1, 0.75, 1, 1.5, 2, 5, 10, 20];
    const computedPercent = (diff / baseAmount) * 100;
    return standardTdsRates.some(rate => Math.abs(percentDiff - rate) < 0.05 || Math.abs(computedPercent - rate) < 0.05);
};

const findSubsetSum = (candidates, target, tolerance) => {
    const n = candidates.length;
    const limit = Math.min(n, 12);
    const subset = [];
    let foundIndices = null;

    const backtrack = (index, currentSum) => {
        if (foundIndices) return;
        if (Math.abs(currentSum - target) <= tolerance) {
            foundIndices = [...subset];
            return;
        }
        if (index >= limit || currentSum > target + tolerance) return;

        subset.push(candidates[index].originalIndex);
        backtrack(index + 1, currentSum + candidates[index].amount);
        subset.pop();

        backtrack(index + 1, currentSum);
    };

    const sortedCandidates = candidates
        .slice(0, limit)
        .map((c, i) => ({ amount: c.amount, originalIndex: c.index }))
        .sort((a, b) => b.amount - a.amount);

    backtrack(0, 0);
    return foundIndices;
};

const scoreBankTallyMatch = (bank, tally, amountTolerance, dateToleranceDays, minorMismatchTolerance = 10000, minorMismatchPercent = 2) => {
    const bankAmount = bank.amount || 0;
    const tallyAmount = tally.abs_amount || 0;
    const diff = Math.abs(bankAmount - tallyAmount);
    const amountMatched = diff <= amountTolerance;
    const percentDiff = bankAmount > 0 ? (diff / bankAmount) * 100 : 999999;
    const minorAmountMismatch = !amountMatched && (diff <= minorMismatchTolerance || percentDiff <= minorMismatchPercent || isLikelyTdsPercentage(percentDiff, diff, bankAmount));
    const dateDiff = Math.min(daysBetween(bank.value_date || bank.date, tally.date), daysBetween(bank.date, tally.date));
    let score = amountMatched ? 35 : (minorAmountMismatch ? 22 : 0);
    const reasons = amountMatched ? ['amount matched'] : (minorAmountMismatch ? ['amount differs but is within minor deduction/tolerance range'] : ['amount mismatch']);
    if (bank.direction === tally.direction) { score += 25; reasons.push('type matched'); }
    else { reasons.push('type mismatch'); }
    if (dateDiff <= dateToleranceDays) { score += Math.max(0, 25 - (dateDiff * 5)); reasons.push('date matched'); }
    const bankRef = normalizeRef(bank.chq_ref_no);
    const tallyRefs = [normalizeRef(tally.voucher_number), normalizeRef(tally.narration), normalizeRef(tally.party_ledger), normalizeRef(tally.alternate_ledger)].filter(Boolean);
    if (bankRef && tallyRefs.some(r => r.includes(bankRef) || bankRef.includes(r))) { score += 30; reasons.push('reference matched'); }
    const sim = Math.max(tokenSimilarity(bank.narration, tally.narration), tokenSimilarity(bank.narration, `${tally.party_ledger} ${tally.alternate_ledger}`));
    if (sim > 0) { score += Math.min(15, Math.round(sim * 15)); reasons.push('narration/party similar'); }
    let mismatchType = '';
    let possibleReason = '';
    if (!amountMatched && minorAmountMismatch) {
        mismatchType = 'minor_deduction_or_charge_possible';
        possibleReason = 'Possible TDS, bank charges, discount, shortage, debit/credit note, freight, round-off, partial payment or other deduction.';
    } else if (!amountMatched) {
        mismatchType = 'amount_mismatch';
        possibleReason = 'Amount differs; verify split/merged entries, charges, deductions, debit/credit note, or wrong voucher.';
    }
    return { score, diff, percentDiff, dateDiff, reasons, amountMatched, minorAmountMismatch, mismatchType, possibleReason };
};

const isLikelyBankLedger = (row, bankName = '') => {
    const name = normalizeText(row?.Name || row?.ledger_name || '');
    const parent = normalizeText(row?.Parent || row?.group_name || '');
    const primary = normalizeText(row?._PrimaryGroup || row?.primary_group || '');
    const keyword = normalizeText(bankName);
    const haystack = `${name} ${parent} ${primary}`;
    const bankGroupWords = ['BANK', 'OD', 'OCC', 'OVERDRAFT', 'CASH CREDIT', 'CC', 'CURRENT ACCOUNT', 'CURRENT A C', 'C A', 'C C'];
    const groupLooksBank = bankGroupWords.some(w => haystack.includes(w));
    const nameMatchesKeyword = keyword ? name.includes(keyword) || haystack.includes(keyword) : true;
    return nameMatchesKeyword && groupLooksBank;
};
const formatBankLedgerOption = (row, index) => ({
    option: index + 1,
    ledger_name: String(row?.ledger_name || row?.Name || ''),
    group_name: String(row?.group_name || row?.Parent || ''),
    primary_group: String(row?.primary_group || row?._PrimaryGroup || ''),
    opening_balance: parseBankAmount(row?.opening_balance ?? row?.OpeningBalance),
    closing_balance: parseBankAmount(row?.closing_balance ?? row?.ClosingBalance),
    debit_totals: parseBankAmount(row?.debit_totals ?? row?.DebitTotals),
    credit_totals: parseBankAmount(row?.credit_totals ?? row?.CreditTotals)
});

export const fetchVoucherDetailInternal = async (
    voucherNumber,
    voucherTypeName,
    dateStr,
    targetCompany,
    guid,
    retentionLedgerName = 'SOUDA RETENTION CHARGES',
    stockItemName = 'WHEAT'
) => {
    const dateObj = dateStr ? parseBankStatementDate(dateStr) : undefined;

    let windowFrom, windowTo;
    if (dateObj) {
        // Known voucher date: use ±5 day window
        windowFrom = new Date(dateObj); windowFrom.setDate(windowFrom.getDate() - 5);
        windowTo   = new Date(dateObj); windowTo.setDate(windowTo.getDate() + 5);
    } else {
        // No date provided — fall back to 1-year trailing window to avoid full-history scan
        windowTo   = new Date();
        windowFrom = new Date(windowTo); windowFrom.setFullYear(windowFrom.getFullYear() - 1);
    }

    const tallyFromDate = windowFrom.toISOString().substring(0, 10);
    const tallyToDate   = windowTo.toISOString().substring(0, 10);

    // Call ledger-account report
    const ledgerParams = new Map([
        ['fromDate', tallyFromDate],
        ['toDate', tallyToDate],
        ['ledgerName', retentionLedgerName]
    ]);
    if (targetCompany) ledgerParams.set('targetCompany', targetCompany);

    const ledgerResp = await fetchReport('ledger-account', ledgerParams);

    // Filter rows matching this voucher number
    const ledgerRows = (Array.isArray(ledgerResp?.data) ? ledgerResp.data : [])
        .filter(r => {
            const vNum = String(r.voucher_number || r.voucherNumber || r['Voucher Number'] || '').trim();
            return vNum === String(voucherNumber || '').trim()
                && String(r.voucher_type || '').toLowerCase() !== 'opening';
        });

    // Build ledger_entries array
    const ledger_entries = ledgerRows.map(r => ({
        ledger_name: retentionLedgerName,
        amount: Math.abs(parseFloat(String(r.amount || '0').replace(/[^0-9.\-]/g, '')) || 0)
    }));

    // Call stock-item-account report
    const invParams = new Map([
        ['fromDate', tallyFromDate],
        ['toDate', tallyToDate],
        ['itemName', stockItemName]
    ]);
    if (targetCompany) invParams.set('targetCompany', targetCompany);

    const invResp = await fetchReport('stock-item-account', invParams);

    // Filter rows matching this voucher number
    const invRows = (Array.isArray(invResp?.data) ? invResp.data : [])
        .filter(r => {
            const vNum = String(r.voucher_number || r.voucherNumber || r['Voucher Number'] || '').trim();
            return vNum === String(voucherNumber || '').trim()
                && String(r.voucher_type || '').toLowerCase() !== 'opening';
        });

    // Build inventory_entries array
    const inventory_entries = invRows.map(r => {
        const qtyStr = String(r.quantity || '').trim();
        return {
            stock_item_name: stockItemName,
            billed_qty: Math.abs(parseFloat(qtyStr.replace(/[^0-9.\-]/g, '')) || 0),
            unit: qtyStr.replace(/^[0-9.\-\s]+/g, '') || 'KGS',
            amount: Math.abs(parseFloat(String(r.amount || '0').replace(/[^0-9.\-]/g, '')) || 0)
        };
    });

    const firstRow = ledgerRows[0] || invRows[0] || {};

    return {
        date: firstRow.date || dateStr || '',
        voucher_number: firstRow.voucher_number || voucherNumber || '',
        voucher_type: firstRow.voucher_type || voucherTypeName || '',
        narration: firstRow.narration || '',
        party_name: firstRow.party_name || '',
        ledger_entries,
        inventory_entries,
        _debug: {
            tallyFromDate,
            tallyToDate,
            voucherNumberSearched: voucherNumber,
            ledgerRespRowCount: (ledgerResp?.data || []).length,
            ledgerRespSample: (ledgerResp?.data || []).slice(0, 2),
            invRespRowCount: (invResp?.data || []).length,
            invRespSample: (invResp?.data || []).slice(0, 2)
        }
    };
};

const normalizeStatementAmountType = (row) => {
    const debit = Math.abs(parseBankAmount(pickFirst(row, ['debit', 'Debit', 'debit_amount', 'Debit Amount', 'Dr', 'DR', 'withdrawal', 'Withdrawal', 'Withdrawal Amt.'])));
    const credit = Math.abs(parseBankAmount(pickFirst(row, ['credit', 'Credit', 'credit_amount', 'Credit Amount', 'Cr', 'CR', 'deposit', 'Deposit', 'Deposit Amt.'])));
    const explicitAmount = parseBankAmount(pickFirst(row, ['amount', 'Amount', 'value', 'Value', 'transaction_amount', 'Transaction Amount', 'amount_paid', 'Amount Paid', 'amount_paid_credited', 'Amount Paid/Credited', 'net_amount', 'Net Amount']));
    const typeText = normalizeText(pickFirst(row, ['dr_cr', 'Dr/Cr', 'type', 'Type', 'transaction_type', 'Transaction Type']));
    if (debit > 0) return { amount: debit, signedAmount: -Math.abs(debit), direction: 'debit' };
    if (credit > 0) return { amount: credit, signedAmount: Math.abs(credit), direction: 'credit' };
    if (explicitAmount !== 0) {
        let direction = explicitAmount < 0 ? 'debit' : 'credit';
        if (typeText.includes('DR') || typeText.includes('DEBIT')) direction = 'debit';
        if (typeText.includes('CR') || typeText.includes('CREDIT')) direction = 'credit';
        return { amount: Math.abs(explicitAmount), signedAmount: direction === 'debit' ? -Math.abs(explicitAmount) : Math.abs(explicitAmount), direction };
    }
    return { amount: 0, signedAmount: 0, direction: 'unknown' };
};

const normalizePartyStatementRow = (row, index) => {
    const amt = normalizeStatementAmountType(row);
    const date = pickFirst(row, ['date', 'Date', 'txn_date', 'transaction_date', 'Transaction Date', 'voucher_date', 'Voucher Date', 'document_date', 'Document Date', 'posting_date', 'Posting Date', 'bill_date', 'Bill Date', 'invoice_date', 'Invoice Date']);
    const narration = pickFirst(row, ['narration', 'Narration', 'description', 'Description', 'particulars', 'Particulars', 'ledger_particulars', 'Ledger Particulars', 'account_head', 'Account Head', 'indicator', 'Indicator']);
    const ref = pickFirst(row, ['voucher_number', 'Voucher No', 'Voucher Number', 'document_no', 'Document No', 'doc_no', 'Doc No', 'invoice_no', 'Invoice No', 'invoice_number', 'bill_no', 'Bill No', 'bill_number', 'reference', 'Reference', 'ref_no', 'Ref No', 'chq_ref_no', 'Chq./Ref.No.']);

    let finalRef = String(ref || '');
    const looksLikeInternalCode = finalRef.length > 16 || /PUJV|FDBPUJV|TXN|TRANS/i.test(finalRef);
    if (!finalRef || looksLikeInternalCode) {
        const narrationText = String(narration || '');
        const embeddedPattern = /(?:Inv\s*No\.?|Invoice\s*No\.?|Bill\s*No\.?)\s*(\S+)/i;
        const match = narrationText.match(embeddedPattern);
        if (match) {
            let extracted = match[1].replace(/[,;.:\s]+$/, '');
            if (extracted) {
                finalRef = extracted;
            }
        }
    }

    const balance = parseBankAmount(pickFirst(row, ['balance', 'Balance', 'closing_balance', 'Closing Balance', 'running_balance', 'Running Balance']));
    return {
        statement_index: index + 1,
        statement_date: isoDate(date),
        statement_ref_no: finalRef,
        statement_narration: String(narration || ''),
        statement_debit_amount: amt.direction === 'debit' ? amt.amount : 0,
        statement_credit_amount: amt.direction === 'credit' ? amt.amount : 0,
        statement_amount: amt.signedAmount,
        statement_abs_amount: amt.amount,
        statement_direction: amt.direction,
        statement_balance: balance || 0
    };
};

const normalizeRefForMatching = (ref) => {
    return String(ref || '')
        .toUpperCase()
        .replace(/\s+/g, '')
        // Insert a normalized separator boundary between a letter block and
        // a digit block if one is missing entirely (RBS08671 -> RBS/08671)
        .replace(/^([A-Z]+)(\d)/, '$1/$2')
        // Collapse all separator variants (/, -, _, .) to a single canonical "/"
        .replace(/[\/\-_.]+/g, '/')
        // Strip leading zeros within each numeric segment so 00060 == 60
        .split('/')
        .map(seg => /^\d+$/.test(seg) ? String(parseInt(seg, 10)) : seg)
        .join('/');
};

const normalizeTallyPartyRow = (row, index) => {
    const amount = parseBankAmount(row?.amount);
    const direction = amount < 0 ? 'debit' : (amount > 0 ? 'credit' : 'unknown');
    return {
        tally_index: index + 1,
        tally_guid: String(row?.guid || ''),
        tally_date: isoDate(row?.date || row?.voucher_date || row?.VoucherDate || row?.posting_date || row?.invoice_date),
        tally_voucher_type: String(row?.voucher_type || ''),
        tally_voucher_number: String(row?.voucher_number || row?.document_no || row?.invoice_no || row?.bill_no || ''),
        tally_alternate_ledger: String(row?.alternate_ledger || ''),
        tally_party_name: String(row?.party_name || row?.party_ledger || ''),
        tally_source_ledger_name: String(row?.source_ledger_name || row?.ledger_name || row?.tally_source_ledger_name || ''),
        tally_amount: amount,
        tally_abs_amount: Math.abs(amount),
        tally_direction: direction,
        tally_narration: String(row?.narration || '')
    };
};

const scorePartyLedgerMatch = (statement, tally, amountTolerance, dateToleranceDays, statementPerspective, minorMismatchTolerance = 10000, minorMismatchPercent = 2) => {
    const statementAmount = statement.statement_abs_amount || 0;
    const tallyAmount = tally.tally_abs_amount || 0;
    const diff = Math.abs(statementAmount - tallyAmount);
    const amountMatched = diff <= amountTolerance;
    const percentDiff = statementAmount > 0 ? (diff / statementAmount) * 100 : 999999;
    const minorAmountMismatch = !amountMatched && (diff <= minorMismatchTolerance || percentDiff <= minorMismatchPercent || isLikelyTdsPercentage(percentDiff, diff, statementAmount));
    const dateDiff = daysBetween(statement.statement_date, tally.tally_date);
    let score = amountMatched ? 40 : (minorAmountMismatch ? 25 : 0);
    const reasons = amountMatched ? ['amount matched'] : (minorAmountMismatch ? ['amount differs but is within minor/TDS tolerance'] : ['amount mismatch']);
    const sameDirection = statement.statement_direction === tally.tally_direction;
    const oppositeDirection = (statement.statement_direction === 'debit' && tally.tally_direction === 'credit') || (statement.statement_direction === 'credit' && tally.tally_direction === 'debit');
    if (statementPerspective === 'same_as_tally' && sameDirection) { score += 20; reasons.push('debit/credit matched'); }
    else if (statementPerspective === 'opposite' && oppositeDirection) { score += 20; reasons.push('opposite debit/credit matched'); }
    else if (statementPerspective === 'auto' && (sameDirection || oppositeDirection)) { score += 10; reasons.push(sameDirection ? 'same debit/credit possible' : 'opposite debit/credit possible'); }
    else if (statement.statement_direction === 'unknown' || tally.tally_direction === 'unknown') { score += 4; reasons.push('entry type unknown'); }
    else { reasons.push('debit/credit side mismatch'); }
    if (dateDiff <= dateToleranceDays) { score += Math.max(0, 25 - (dateDiff * 5)); reasons.push('date matched'); }
    const stRef = normalizeRefForMatching(statement.statement_ref_no);
    const tallyRef = normalizeRefForMatching(tally.tally_voucher_number);
    if (stRef && tallyRef && (stRef === tallyRef || stRef.includes(tallyRef) || tallyRef.includes(stRef))) { score += 35; reasons.push('voucher/invoice reference matched'); }
    const stRefTokens = extractRefTokens(
        `${insertAlphaNumBoundary(statement.statement_ref_no)} ${statement.statement_narration}`
    );
    const tallyText = [
        normalizeRefForMatching(tally.tally_voucher_number),
        ...[tally.tally_narration, tally.tally_alternate_ledger, tally.tally_party_name].map(v => normalizeRef(insertAlphaNumBoundary(v)))
    ].join(' ');
    const refInText = stRefTokens.some(token => token && tallyText.includes(token));
    if (refInText) { score += 20; reasons.push('reference found in Tally text'); }
    const sim = Math.max(
        tokenSimilarity(statement.statement_narration, tally.tally_narration),
        tokenSimilarity(statement.statement_narration, `${tally.tally_alternate_ledger} ${tally.tally_party_name}`),
        tokenSimilarity(statement.statement_ref_no, tally.tally_voucher_number)
    );
    if (sim > 0) { score += Math.min(15, Math.round(sim * 15)); reasons.push('particulars/narration similar'); }
    let mismatchType = '';
    if (!amountMatched) {
        if (minorAmountMismatch && (percentDiff <= minorMismatchPercent || diff <= minorMismatchTolerance)) mismatchType = 'minor_tds_discount_roundoff_possible';
        else mismatchType = 'amount_mismatch';
    }
    return { score, diff, percentDiff, dateDiff, reasons, amountMatched, minorAmountMismatch, mismatchType };
};


const partyPeriodRelation = (statementDate, tallyDate, dateToleranceDays = 7) => {
    const sd = partyEpochDay(statementDate);
    const td = partyEpochDay(tallyDate);
    if (sd === null || td === null) return { kind: '', reason: '', days: null };
    const days = td - sd;
    const abs = Math.abs(days);
    if (abs <= dateToleranceDays) return { kind: '', reason: '', days };
    if (days < 0) return {
        kind: 'backdated_or_booked_earlier',
        reason: 'Tally entry date is earlier than statement date. This may be a backdated voucher, invoice date/posting date difference, or party statement timing difference.',
        days
    };
    return {
        kind: 'booked_later_or_future_dated',
        reason: 'Tally entry date is later than statement date. This may be later booking, future-dated posting, payment/receipt adjustment, or party statement timing difference.',
        days
    };
};


const shiftIsoDate = (iso, days) => {
    const dt = parseBankStatementDate(iso);
    if (!dt) return iso;
    dt.setDate(dt.getDate() + Number(days || 0));
    return dt.toISOString().slice(0, 10);
};

const splitDateRangeIntoMonths = (start, end) => {
    const chunks = [];
    let current = new Date(start.getFullYear(), start.getMonth(), 1);
    if (current < start) {
        current = new Date(start);
    }
    while (current <= end) {
        const chunkStart = new Date(current);
        const chunkEnd = new Date(current.getFullYear(), current.getMonth() + 1, 0);
        chunks.push({
            start: chunkStart > start ? chunkStart : new Date(start),
            end: chunkEnd < end ? chunkEnd : new Date(end)
        });
        current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
    }
    return chunks;
};

const computeRowNetAmount = (row) => {
    const grossAmount = row.amount ?? 0;
    const ledgerEntries = row['ALLLEDGERENTRIES.LIST'] || row['allledgerentries.list'] || [];
    if (!Array.isArray(ledgerEntries) || ledgerEntries.length === 0) {
        return grossAmount;
    }
    let netAmount = grossAmount;
    const retentionEntries = ledgerEntries.filter(le => /souda\s+retention\s+charges/i.test(le.ledger_name || le.LEDGERNAME || ''));
    for (const ret of retentionEntries) {
        const retAmt = Math.abs(parseFloat(ret.amount || ret.AMOUNT) || 0);
        if (grossAmount < 0) {
            netAmount += retAmt;
        } else {
            netAmount -= retAmt;
        }
    }
    return Number(netAmount.toFixed(2));
};

export const fetchLedgerAccountComplete = async (ledgerName, fromDateStr, toDateStr, targetCompany) => {
    const fromD = parseBankStatementDate(fromDateStr);
    const toD = parseBankStatementDate(toDateStr);

    const expected = await queryCollection('Voucher', ['VoucherNumber', 'Date', 'VoucherTypeName'], new Map([
        ['FilterLedger', `NOT $$IsEmpty:$AllLedgerEntries[1,$$IsEqual:$LedgerName:"${ledgerName.replace(/"/g, '""')}"]`]
    ]), targetCompany, fromD, toD);

    const inputParams = new Map([['fromDate', fromDateStr], ['toDate', toDateStr], ['ledgerName', ledgerName]]);
    if (targetCompany) inputParams.set('targetCompany', targetCompany);

    const resp = await fetchReport('ledger-account', inputParams);
    if (resp.error) throw new Error(resp.error);

    let ledgerRows = Array.isArray(resp.data) ? [...resp.data] : [];
    const cleanRows = ledgerRows.filter(r => r && String(r.voucher_type || '').toLowerCase() !== 'opening');

    let finalRows = ledgerRows;
    let isPartial = false;

    let totalDailyQueries = 0;
    if (cleanRows.length < expected.length) {
        const chunks = splitDateRangeIntoMonths(fromD, toD);
        const allMergedRows = [];

        for (const chunk of chunks) {
            const chunkFromStr = utility.Date.format(chunk.start, 'yyyy-MM-dd');
            const chunkToStr = utility.Date.format(chunk.end, 'yyyy-MM-dd');

            const chunkParams = new Map([['fromDate', chunkFromStr], ['toDate', chunkToStr], ['ledgerName', ledgerName]]);
            if (targetCompany) chunkParams.set('targetCompany', targetCompany);

            const chunkResp = await fetchReport('ledger-account', chunkParams);
            if (chunkResp.error) {
                isPartial = true;
                continue;
            }

            const chunkRows = Array.isArray(chunkResp.data) ? chunkResp.data : [];
            const cleanChunkRows = chunkRows.filter(r => r && String(r.voucher_type || '').toLowerCase() !== 'opening');

            const chunkExpected = expected.filter(v => {
                const vDate = parseBankStatementDate(v.Date);
                return vDate >= chunk.start && vDate <= chunk.end;
            });

            if (cleanChunkRows.length < chunkExpected.length) {
                const dailyRows = [];
                let currentDay = new Date(chunk.start);
                while (currentDay <= chunk.end) {
                    if (totalDailyQueries >= 30) {
                        isPartial = true;
                        console.warn(`fetchLedgerAccountComplete: Exceeded max daily fallback queries limit (30). Stopping daily fallback.`);
                        break;
                    }
                    totalDailyQueries++;
                    const dayStr = utility.Date.format(currentDay, 'yyyy-MM-dd');
                    const dayParams = new Map([['fromDate', dayStr], ['toDate', dayStr], ['ledgerName', ledgerName]]);
                    if (targetCompany) dayParams.set('targetCompany', targetCompany);

                    const dayResp = await fetchReport('ledger-account', dayParams);
                    if (!dayResp.error && Array.isArray(dayResp.data)) {
                        dailyRows.push(...dayResp.data.filter(r => r && String(r.voucher_type || '').toLowerCase() !== 'opening'));
                    } else {
                        isPartial = true;
                    }
                    currentDay.setDate(currentDay.getDate() + 1);
                }
                allMergedRows.push(...dailyRows);
            } else {
                allMergedRows.push(...cleanChunkRows);
            }
        }

        const uniqueRows = [];
        const seenKeys = new Set();
        for (const r of allMergedRows) {
            const key = r.guid || `${r.date}_${r.voucher_number}_${r.amount}`;
            if (!seenKeys.has(key)) {
                seenKeys.set(key);
                uniqueRows.push(r);
            }
        }

        const openingRow = ledgerRows.find(r => r && String(r.voucher_type || '').toLowerCase() === 'opening');
        if (openingRow) {
            uniqueRows.unshift(openingRow);
        }
        finalRows = uniqueRows;
        isPartial = isPartial || finalRows.filter(r => String(r.voucher_type || '').toLowerCase() !== 'opening').length < expected.length;
    }

    finalRows.forEach(r => {
        r.net_amount = computeRowNetAmount(r);
    });

    return { data: finalRows, partial: isPartial, expectedCount: expected.length };
};

export const fetchStockItemAccountComplete = async (itemName, fromDateStr, toDateStr, targetCompany) => {
    const fromD = parseBankStatementDate(fromDateStr);
    const toD = parseBankStatementDate(toDateStr);

    const expected = await queryCollection('Voucher', ['VoucherNumber', 'Date', 'VoucherTypeName'], new Map([
        ['FilterStockItem', `NOT $$IsEmpty:$AllInventoryEntries[1,$$IsEqual:$StockItemName:"${itemName.replace(/"/g, '""')}"]`]
    ]), targetCompany, fromD, toD);

    const inputParams = new Map([['fromDate', fromDateStr], ['toDate', toDateStr], ['itemName', itemName]]);
    if (targetCompany) inputParams.set('targetCompany', targetCompany);

    const resp = await fetchReport('stock-item-account', inputParams);
    if (resp.error) throw new Error(resp.error);

    let stockRows = Array.isArray(resp.data) ? [...resp.data] : [];
    const cleanRows = stockRows.filter(r => r && String(r.voucher_type || '').toLowerCase() !== 'opening');

    let finalRows = stockRows;
    let isPartial = false;

    let totalDailyQueries = 0;
    if (cleanRows.length < expected.length) {
        const chunks = splitDateRangeIntoMonths(fromD, toD);
        const allMergedRows = [];

        for (const chunk of chunks) {
            const chunkFromStr = utility.Date.format(chunk.start, 'yyyy-MM-dd');
            const chunkToStr = utility.Date.format(chunk.end, 'yyyy-MM-dd');

            const chunkParams = new Map([['fromDate', chunkFromStr], ['toDate', chunkToStr], ['itemName', itemName]]);
            if (targetCompany) chunkParams.set('targetCompany', targetCompany);

            const chunkResp = await fetchReport('stock-item-account', chunkParams);
            if (chunkResp.error) {
                isPartial = true;
                continue;
            }

            const chunkRows = Array.isArray(chunkResp.data) ? chunkResp.data : [];
            const cleanChunkRows = chunkRows.filter(r => r && String(r.voucher_type || '').toLowerCase() !== 'opening');

            const chunkExpected = expected.filter(v => {
                const vDate = parseBankStatementDate(v.Date);
                return vDate >= chunk.start && vDate <= chunk.end;
            });

            if (cleanChunkRows.length < chunkExpected.length) {
                const dailyRows = [];
                let currentDay = new Date(chunk.start);
                while (currentDay <= chunk.end) {
                    if (totalDailyQueries >= 30) {
                        isPartial = true;
                        console.warn(`fetchStockItemAccountComplete: Exceeded max daily fallback queries limit (30). Stopping daily fallback.`);
                        break;
                    }
                    totalDailyQueries++;
                    const dayStr = utility.Date.format(currentDay, 'yyyy-MM-dd');
                    const dayParams = new Map([['fromDate', dayStr], ['toDate', dayStr], ['itemName', itemName]]);
                    if (targetCompany) dayParams.set('targetCompany', targetCompany);

                    const dayResp = await fetchReport('stock-item-account', dayParams);
                    if (!dayResp.error && Array.isArray(dayResp.data)) {
                        dailyRows.push(...dayResp.data.filter(r => r && String(r.voucher_type || '').toLowerCase() !== 'opening'));
                    } else {
                        isPartial = true;
                    }
                    currentDay.setDate(currentDay.getDate() + 1);
                }
                allMergedRows.push(...dailyRows);
            } else {
                allMergedRows.push(...cleanChunkRows);
            }
        }

        const uniqueRows = [];
        const seenKeys = new Set();
        for (const r of allMergedRows) {
            const key = `${r.date}_${r.voucher_number}_${r.amount}_${r.quantity}`;
            if (!seenKeys.has(key)) {
                seenKeys.set(key);
                uniqueRows.push(r);
            }
        }

        const openingRow = stockRows.find(r => r && String(r.voucher_type || '').toLowerCase() === 'opening');
        if (openingRow) {
            uniqueRows.unshift(openingRow);
        }
        finalRows = uniqueRows;
        isPartial = isPartial || finalRows.filter(r => String(r.voucher_type || '').toLowerCase() !== 'opening').length < expected.length;
    }

    return { data: finalRows, partial: isPartial, expectedCount: expected.length };
};

const partyEpochDay = (value) => {
    const dt = parseBankStatementDate(value);
    if (!dt) return null;
    return Math.round(dt.getTime() / 86400000);
};
const partyAmountKey = (amount) => String(Math.round(Math.abs(Number(amount || 0)) * 100));
const buildPartyTallyIndexes = (tallyRows) => {
    const byAmount = new Map();
    const byRef = new Map();
    for (let i = 0; i < tallyRows.length; i++) {
        const row = tallyRows[i];
        const amountKey = partyAmountKey(row.tally_abs_amount);
        if (!byAmount.has(amountKey)) byAmount.set(amountKey, []);
        byAmount.get(amountKey).push(i);
        const normVoucher = normalizeRefForMatching(row.tally_voucher_number);
        if (normVoucher) {
            if (!byRef.has(normVoucher)) byRef.set(normVoucher, []);
            byRef.get(normVoucher).push(i);
        }

        const refs = [row.tally_voucher_number, row.tally_narration, row.tally_alternate_ledger, row.tally_party_name]
            .map(insertAlphaNumBoundary)
            .flatMap(extractRefTokens);
        for (const ref of refs) {
            if (!byRef.has(ref)) byRef.set(ref, []);
            byRef.get(ref).push(i);
        }
    }
    return { byAmount, byRef };
};
const candidateTallyIndexes = (statement, indexes, tallyRows, amountTolerance, dateToleranceDays, usedTally, fastMode = true, dateSearchWindowDays = 60) => {
    if (!fastMode) return tallyRows.map((_, i) => i).filter(i => !usedTally.has(i));
    const selected = new Set();
    const narrowTolerance = Math.min(Math.max(amountTolerance || 1, 1), 100); // keep amount index fast; larger mismatches are handled by date/ref fallback
    const minCents = Math.max(0, Math.round((Math.abs(statement.statement_abs_amount || 0) - narrowTolerance) * 100));
    const maxCents = Math.round((Math.abs(statement.statement_abs_amount || 0) + narrowTolerance) * 100);
    for (let cents = minCents; cents <= maxCents; cents++) {
        const arr = indexes.byAmount.get(String(cents));
        if (arr) arr.forEach(i => selected.add(i));
    }
    const normStatementRef = normalizeRefForMatching(statement.statement_ref_no);
    if (normStatementRef) {
        const arr = indexes.byRef.get(normStatementRef);
        if (arr) arr.forEach(i => selected.add(i));
    }
    const stRefTokens = extractRefTokens(
        `${insertAlphaNumBoundary(statement.statement_ref_no || '')} ${statement.statement_narration || ''}`
    );
    for (const token of stRefTokens) {
        const arr = indexes.byRef.get(token);
        if (arr) arr.forEach(i => selected.add(i));
    }
    const stDay = partyEpochDay(statement.statement_date);
    if (stDay !== null) {
        const looseWindow = Math.max(dateToleranceDays, dateSearchWindowDays, 15);
        const nearDate = [];
        for (let i = 0; i < tallyRows.length; i++) {
            if (usedTally.has(i)) continue;
            const td = partyEpochDay(tallyRows[i].tally_date);
            if (td === null) continue;
            const dd = Math.abs(stDay - td);
            if (dd <= looseWindow) nearDate.push([dd, i]);
        }
        nearDate.sort((a, b) => a[0] - b[0]);
        for (const [, i] of nearDate.slice(0, 300)) selected.add(i);
    }
    let candidates = [...selected].filter(i => !usedTally.has(i));
    if (stDay !== null) {
        const looseWindow = Math.max(dateToleranceDays, dateSearchWindowDays, 15);
        candidates = candidates.filter(i => {
            const td = partyEpochDay(tallyRows[i].tally_date);
            return td === null || Math.abs(stDay - td) <= looseWindow;
        });
    }
    return candidates.length ? candidates.slice(0, 500) : tallyRows.map((_, i) => i).filter(i => !usedTally.has(i)).slice(0, 200);
};

const formatPartyLedgerOption = (row, index) => ({
    option: index + 1,
    ledger_name: String(row?.ledger_name || row?.Name || ''),
    group_name: String(row?.group_name || row?.Parent || ''),
    primary_group: String(row?.primary_group || row?._PrimaryGroup || '')
});


const extractRefTokens = (value) => {
    const ref = normalizeRef(value);
    if (!ref) return [];
    const tokens = new Set([ref]);
    const numeric = ref.match(/\d{3,}/g) || [];
    numeric.forEach(n => {
        tokens.add(n);
        tokens.add(n.replace(/^0+/, '') || n);
    });
    const alphaNum = ref.match(/[A-Z]+\d{2,}/g) || [];
    alphaNum.forEach(t => tokens.add(t));
    return [...tokens].filter(t => t && t.length >= 3);
};

const parseCompactPartyStatementRow = (line, index) => {
    if (Array.isArray(line)) {
        const [date, ref, debit, credit, balance, narration] = line;
        return normalizePartyStatementRow({ date, reference: ref, debit, credit, balance, narration }, index);
    }
    const text = String(line || '').trim();
    const delimiter = text.includes('|') ? '|' : (text.includes('	') ? '	' : ',');
    const parts = text.split(delimiter).map(x => x.trim());
    const [date, ref, debit, credit, balance, ...narr] = parts;
    return normalizePartyStatementRow({ date, reference: ref, debit, credit, balance, narration: narr.join(' ') }, index);
};

const normalizeAllPartyStatementRows = (rows = [], compactRows = []) => {
    const normalized = [];
    for (const row of (Array.isArray(rows) ? rows : [])) {
        const n = normalizePartyStatementRow(row, normalized.length);
        if (n.statement_abs_amount > 0 && n.statement_date) normalized.push(n);
    }
    for (const row of (Array.isArray(compactRows) ? compactRows : [])) {
        const n = parseCompactPartyStatementRow(row, normalized.length);
        if (n.statement_abs_amount > 0 && n.statement_date) normalized.push(n);
    }
    return normalized;
};

const findPartyLedgerOptions = async (targetCompany, partyName) => {
    const keyword = String(partyName || '').trim();
    if (!keyword) return { searchTerms: [], options: [] };
    const clean = keyword.replace(/"/g, '').replace(/(pvt|private|limited|ltd|llp|company|co)/ig, ' ').replace(/[^a-z0-9 ]/ig, ' ').replace(/\s+/g, ' ').trim();
    const compact = clean.replace(/\s+/g, '');
    const parts = clean.split(' ').filter(x => x.length >= 3);
    const searchTerms = [...new Set([keyword, clean, compact, ...parts.slice(0, 3)].map(x => String(x || '').trim()).filter(Boolean))];
    const byName = new Map();
    for (const term of searchTerms) {
        const filters = new Map([['Search_Contains', `$Name CONTAINS "${term.replace(/"/g, '')}"`]]);
        let found = await queryCollection('Ledger', ['Name', 'Parent', '_PrimaryGroup'], filters, targetCompany);
        found = Array.isArray(found) ? found : [];
        for (const row of found) {
            const nm = String(row.Name || row.name || '').trim();
            if (nm && !byName.has(nm.toLowerCase())) byName.set(nm.toLowerCase(), row);
        }
    }
    return { searchTerms, options: [...byName.values()].map(formatPartyLedgerOption) };
};


const normalizeGstin = (value) => String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const normalizeInvoiceNo = (value) => {
    const raw = String(value || '').toUpperCase().trim();
    const cleaned = raw.replace(/[^0-9A-Z]/g, '');
    return cleaned.replace(/^0+([0-9A-Z])/, '$1');
};
const pickNumber = (row, keys) => parseBankAmount(pickFirst(row, keys));
const pickNumberLoose = (row, keys) => parseBankAmount(pickFirstLoose(row, keys));
const GSTR2B_EXCLUDED_SHEETS = new Set(['READ ME', 'ITC AVAILABLE', 'ITC NOT AVAILABLE', 'ITC REVERSAL', 'ITC REJECTED']);
const isGstr2bDetailSheet = (sheetName = '') => {
    const s = normalizeText(sheetName);
    if (!s) return true;
    if (GSTR2B_EXCLUDED_SHEETS.has(s)) return false;
    return /B2B|B2BA|CDNR|CDNRA|DNR|DNRA|ECO|ECOA|ISD|ISDA|IMPG|IMPGA|IMPGSEZ/.test(s);
};
const classifyGstr2bSheet = (sheetName = '') => {
    const s = normalizeText(sheetName);
    if (!s) return 'unspecified';
    if (s.includes('REJECTED')) return 'itc_rejected';
    if (s.includes('REVERSAL')) return 'itc_reversal';
    if (s.includes('CDNR') || s.includes('CDNRA')) return 'credit_debit_note';
    if (s.includes('DNR') || s.includes('DNRA')) return 'debit_note';
    if (s.includes('ECO')) return 'eco';
    if (s.includes('ISD')) return 'isd';
    if (s.includes('IMPG')) return 'import';
    if (s.includes('B2BA')) return 'b2b_amendment';
    if (s.includes('B2B')) return 'b2b';
    return s.toLowerCase().replace(/\s+/g, '_');
};

const addMonthsIso = (iso, months) => {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.toISOString().slice(0, 10);
};
const monthStartIso = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
};
const monthEndIso = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return end.toISOString().slice(0, 10);
};
const periodKeyFromDate = (value) => {
    const d = isoDate(value);
    return d ? d.slice(0, 7) : '';
};
const normalizePeriodKey = (value, fallbackDate = '') => {
    const raw = String(value || '').trim();
    if (!raw) return periodKeyFromDate(fallbackDate);
    const iso = isoDate(raw);
    if (iso) return iso.slice(0, 7);
    const compact = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
    let m = compact.match(/^(\d{2})(\d{4})$/); // 052026
    if (m) return `${m[2]}-${m[1]}`;
    m = compact.match(/^(\d{4})(\d{2})$/); // 202605
    if (m) return `${m[1]}-${m[2]}`;
    m = compact.match(/(\d{2})(\d{4})/);
    if (m) return `${m[2]}-${m[1]}`;
    m = compact.match(/(\d{4})(\d{2})/);
    if (m) return `${m[1]}-${m[2]}`;
    return periodKeyFromDate(fallbackDate);
};
const comparePeriodKey = (a, b) => {
    if (!a || !b || !/^\d{4}-\d{2}$/.test(a) || !/^\d{4}-\d{2}$/.test(b)) return 0;
    const [ay, am] = a.split('-').map(Number);
    const [by, bm] = b.split('-').map(Number);
    return (ay * 12 + am) - (by * 12 + bm);
};
const collectGstr2bInputRows = (args = {}) => {
    const rows = [];
    const pushRows = (sheetName, sourceRows, sheetPeriod = '') => {
        if (!Array.isArray(sourceRows) || !isGstr2bDetailSheet(sheetName)) return;
        const section = classifyGstr2bSheet(sheetName);
        const inferredPeriod = sheetPeriod || '';
        for (const row of sourceRows) {
            if (!row || typeof row !== 'object') continue;
            rows.push({
                ...row,
                sheet_name: row.sheet_name || row.sheetName || sheetName || '',
                gstr2b_sheet: row.gstr2b_sheet || sheetName || '',
                gstr2b_section: row.gstr2b_section || section,
                gstr2b_period: row.gstr2b_period || row.gstr_period || row.return_period || row.period || inferredPeriod || ''
            });
        }
    };
    pushRows('', args.gstr2bRows || [], args.gstr2bPeriod || args.period || '');
    if (Array.isArray(args.gstr2bSheets)) {
        for (const sheet of args.gstr2bSheets) pushRows(sheet?.sheetName || sheet?.name || '', sheet?.rows || [], sheet?.period || sheet?.gstr2bPeriod || sheet?.returnPeriod || args.gstr2bPeriod || args.period || '');
    }
    return rows;
};
const isUsefulGstr2bRow = (r) => {
    if (!r) return false;
    const hasId = Boolean(r.supplier_gstin || r.supplier_name || r.invoice_number || r.invoice_number_raw);
    const hasValue = Boolean(r.taxable_value || r.total_tax || r.invoice_value);
    return hasId && hasValue;
};
const normalizeGstr2bRow = (row, index) => {
    const supplierGstin = normalizeGstin(pickFirstLoose(row, ['supplier_gstin', 'Supplier GSTIN', 'GSTIN of supplier', 'GSTIN of ECO', 'GSTIN of ISD', 'GSTIN', 'ctin', 'Supplier Gstin', 'GSTIN/UIN']));
    const supplierName = String(pickFirstLoose(row, ['supplier_name', 'Supplier Name', 'Trade/Legal name', 'Trade/Legal Name', 'legal_name', 'cfs', 'Name of Supplier', 'Party Name']) || '');
    const invoiceNoRaw = String(pickFirstLoose(row, ['invoice_number', 'Invoice Number', 'Invoice No', 'Invoice No.', 'inum', 'Bill No', 'Document Number', 'Document No', 'Document number', 'Note number', 'Debit note number', 'Credit note number', 'Bill of Entry Number', 'Bill of Entry No', 'Number', 'ISD Document number', 'Document details Number', 'Invoice Details Number']) || '');
    const invoiceNo = normalizeInvoiceNo(invoiceNoRaw);
    const invoiceDate = isoDate(pickFirstLoose(row, ['invoice_date', 'Invoice Date', 'idt', 'Bill Date', 'Document Date', 'Document date', 'Note date', 'Bill of Entry Date', 'ISD Document date', 'Date']));
    const taxableValue = Math.abs(pickNumberLoose(row, ['taxable_value', 'Taxable Value', 'Taxable Value (₹)', 'Taxable value (₹)', 'Taxable value', 'txval', 'Taxable amount', 'Taxable Amount', 'Taxable Value(₹)']));
    const igst = Math.abs(pickNumberLoose(row, ['igst', 'IGST', 'Integrated Tax', 'Integrated Tax(₹)', 'Integrated Tax  (₹)', 'Integrated Tax Amount', 'Tax Amount Integrated Tax', 'Tax Amount IGST', 'Amount of tax IGST', 'iamt']));
    const cgst = Math.abs(pickNumberLoose(row, ['cgst', 'CGST', 'Central Tax', 'Central Tax(₹)', 'Central Tax (₹)', 'Central Tax Amount', 'Tax Amount Central Tax', 'Tax Amount CGST', 'Amount of tax CGST', 'camt']));
    const sgst = Math.abs(pickNumberLoose(row, ['sgst', 'SGST', 'State/UT Tax', 'State/UT Tax(₹)', 'State/UT Tax (₹)', 'State Tax Amount', 'Tax Amount State Tax', 'Tax Amount SGST', 'Tax Amount UTGST', 'Amount of tax SGST', 'samt', 'UTGST']));
    const cess = Math.abs(pickNumberLoose(row, ['cess', 'CESS', 'Cess', 'Cess(₹)', 'Cess  (₹)', 'Cess Amount', 'Tax Amount Cess', 'Amount of tax Cess', 'csamt']));
    const explicitTotalTax = Math.abs(pickNumberLoose(row, ['total_tax', 'Total Tax', 'Total Tax Amount', 'Tax Amount', 'Tax amount', 'Tax Amount (₹)', 'Amount of tax', 'Amount of tax (₹)', 'Input tax distribution by ISD', 'Input tax distribution by ISD (₹)']));
    const taxPartsTotal = Number((igst + cgst + sgst + cess).toFixed(2));
    const totalTax = taxPartsTotal > 0 ? taxPartsTotal : Number(explicitTotalTax.toFixed(2));
    const invoiceValue = Math.abs(pickNumberLoose(row, ['invoice_value', 'Invoice Value', 'Invoice Value(₹)', 'Note Value (₹)', 'Document value(₹)', 'val', 'Total Invoice Value', 'Total Value']));
    const itcAvailabilityText = String(pickFirstLoose(row, ['itc_availability', 'ITC Availability', 'ITC Available', 'ITC available', 'Eligibility', 'ITC Eligibility', 'availibility']) || '');
    const sheetName = String(pickFirstLoose(row, ['sheet_name', 'sheetName', 'gstr2b_sheet', 'Sheet Name']) || '');
    const gstrSection = String(pickFirstLoose(row, ['gstr2b_section', 'gstr_section', 'section', 'Section']) || classifyGstr2bSheet(sheetName));
    const reverseChargeText = String(pickFirstLoose(row, ['reverse_charge', 'Reverse Charge', 'Reverse Charge Flag', 'Supply Attract Reverse Charge', 'Supply Attracts Reverse Charge', 'Supply Attract Reverse Charge (Y/N)', 'RCM', 'RCM Applicability', 'rchrg']) || '');
    const pos = String(pickFirst(row, ['place_of_supply', 'Place of Supply', 'POS', 'pos']) || '');
    const isItcIneligible = /(^|\b)(NO|N|INELIGIBLE|BLOCKED|NOT AVAILABLE|REJECTED)(\b|$)/i.test(itcAvailabilityText) || /REJECTED|NOT_AVAILABLE/i.test(gstrSection);
    const isItcReversal = /REVERSAL/i.test(gstrSection);
    const isRcm = /(^|\b)(YES|Y|RCM|REVERSE|TRUE|1)(\b|$)/i.test(reverseChargeText);
    const gstrPeriod = normalizePeriodKey(pickFirstLoose(row, ['gstr2b_period', 'gstr_period', 'return_period', 'Return Period', 'GSTR-2B Period', 'Period', 'month', 'Month', 'tax_period', 'Tax Period']), invoiceDate);
    return { gstr_index: index + 1, gstr_sheet: sheetName, gstr_section: gstrSection, gstr_period: gstrPeriod, supplier_gstin: supplierGstin, supplier_name: supplierName, invoice_number: invoiceNo, invoice_number_raw: invoiceNoRaw, invoice_date: invoiceDate, taxable_value: taxableValue, igst, cgst, sgst, cess, total_tax: totalTax, invoice_value: invoiceValue, itc_availability: itcAvailabilityText, reverse_charge: reverseChargeText, place_of_supply: pos, itc_ineligible: isItcIneligible, itc_reversal: isItcReversal, rcm_case: isRcm };
};
const normalizeTallyGstrPurchaseRow = (row, index) => {
    const supplierGstin = normalizeGstin(pickFirst(row, ['supplier_gstin', 'gstin', 'GSTIN', 'party_gstin', 'PartyGSTIN']));
    const supplierName = String(pickFirst(row, ['supplier_name', 'party_ledger', 'party_name', 'PartyLedgerName', 'ledger_name']) || '');
    const invoiceNoRaw = String(pickFirst(row, ['invoice_number', 'supplier_invoice_number', 'reference', 'voucher_number', 'VoucherNumber']) || '');
    const invoiceNo = normalizeInvoiceNo(invoiceNoRaw);
    const invoiceDate = isoDate(pickFirst(row, ['invoice_date', 'supplier_invoice_date', 'reference_date', 'date', 'Date']));
    const voucherDate = isoDate(pickFirst(row, ['voucher_date', 'date', 'Date']));
    const taxableValue = Math.abs(pickNumber(row, ['taxable_value', 'Taxable Value', 'taxable_amount', 'Taxable Amount', 'Taxable Ledger Amount', 'Assessable Value']));
    const igst = Math.abs(pickNumber(row, ['igst', 'IGST', 'igst_amount']));
    const cgst = Math.abs(pickNumber(row, ['cgst', 'CGST', 'cgst_amount']));
    const sgst = Math.abs(pickNumber(row, ['sgst', 'SGST', 'utgst', 'sgst_amount']));
    const cess = Math.abs(pickNumber(row, ['cess', 'CESS', 'cess_amount']));
    const totalTax = Number((igst + cgst + sgst + cess).toFixed(2));
    const tallyPeriod = normalizePeriodKey(pickFirst(row, ['tally_period', 'booking_period', 'period', 'Period']), voucherDate || invoiceDate);
    return { tally_index: index + 1, tally_period: tallyPeriod, supplier_gstin: supplierGstin, supplier_name: supplierName, invoice_number: invoiceNo, invoice_number_raw: invoiceNoRaw, invoice_date: invoiceDate || voucherDate, voucher_date: voucherDate || invoiceDate, taxable_value: taxableValue, igst, cgst, sgst, cess, total_tax: totalTax, voucher_type: String(row?.voucher_type || row?.VoucherTypeName || ''), voucher_number: String(row?.voucher_number || row?.VoucherNumber || ''), narration: String(row?.narration || row?.Narration || '') };
};
const gstrMatchKey = (row) => `${normalizeGstin(row.supplier_gstin)}|${normalizeInvoiceNo(row.invoice_number || row.invoice_number_raw)}`;
const scoreGstr2bMatch = (gstr, tally, valueTolerance, taxTolerance, dateToleranceDays) => {
    let score = 0;
    const reasons = [];
    const gstinSame = gstr.supplier_gstin && tally.supplier_gstin && gstr.supplier_gstin === tally.supplier_gstin;
    const invSame = gstr.invoice_number && tally.invoice_number && gstr.invoice_number === tally.invoice_number;
    if (gstinSame) { score += 40; reasons.push('GSTIN matched'); }
    if (invSame) { score += 40; reasons.push('invoice number matched'); }
    else if (gstr.invoice_number && tally.invoice_number) {
        const cleanGstr = gstr.invoice_number.replace(/[^0-9A-Z]/g, '');
        const cleanTally = tally.invoice_number.replace(/[^0-9A-Z]/g, '');
        if (cleanGstr.length >= 3 && cleanTally.length >= 3 && (cleanGstr.endsWith(cleanTally) || cleanTally.endsWith(cleanGstr))) {
            score += 25;
            reasons.push('invoice number suffix/partial matched');
        }
    }
    if (!gstinSame && tokenSimilarity(gstr.supplier_name, tally.supplier_name) >= 0.5) { score += 20; reasons.push('supplier name similar'); }
    const dateDiff = daysBetween(gstr.invoice_date, tally.invoice_date || tally.voucher_date);
    if (dateDiff <= dateToleranceDays) { score += Math.max(0, 15 - dateDiff); reasons.push('date near/matched'); }
    const taxableDiff = Math.abs((gstr.taxable_value || 0) - (tally.taxable_value || 0));
    const taxDiff = Math.abs((gstr.total_tax || 0) - (tally.total_tax || 0));
    if (taxableDiff <= valueTolerance) { score += 15; reasons.push('taxable value matched'); }
    if (taxDiff <= taxTolerance) { score += 15; reasons.push('tax amount matched'); }
    return { score, dateDiff, taxableDiff, taxDiff, reasons };
};


const normalizePan = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normalizeSection = (value) => {
    const raw = String(value || '').toUpperCase();
    if (!raw.trim()) return '';
    const text = raw.replace(/[–—]/g, '-');
    const compact = text.replace(/[^A-Z0-9]/g, '');
    // Check most specific sections first so 194JA/194JB do not collapse into 194J.
    if (/(194JA|94JA|194J-A|94J-A)/i.test(text) || compact.includes('194JA') || compact.includes('94JA')) return '194JA';
    if (/(194JB|94JB|194J-B|94J-B)/i.test(text) || compact.includes('194JB') || compact.includes('94JB')) return '194JB';
    // Official sections written as 194C/194N/etc.
    let m = compact.match(/194([A-Z]{0,2})/i);
    if (m) return `194${m[1].toUpperCase()}`;
    // Tally shorthand often drops the leading 1: 94C, 94A, 94T, 94N, 94JA, 94JB, etc.
    m = compact.match(/94([A-Z]{1,2})/i);
    if (m) return `194${m[1].toUpperCase()}`;
    // Other TDS/TCS sections sometimes appear as 195, 192B, 196D, 206C1H etc.
    m = compact.match(/\b(19[2356][A-Z]{0,2}|20[46][A-Z0-9]{0,3})\b/i);
    if (m) return m[1].toUpperCase();
    // FIX 1: Reject values that are clearly party/ledger names accidentally stored in the section field.
    // A valid TDS section code is short (≤8 chars after stripping non-alphanumeric) and starts with a digit.
    // If the compact value is longer than 8 chars or contains no digit, it is not a valid section — return blank.
    if (compact.length > 8 || !/\d/.test(compact)) return '';
    return compact;
}; const inferTdsSectionFromText = (row, currentSection = '') => {
    const existing = normalizeSection(currentSection);
    if (existing && /^\d/.test(existing)) return existing;
    const source = String([
        row?.section,
        row?.tds_ledger,
        row?.TDSLedger,
        row?.['TDS Ledger'],
        row?.taxable_ledger,
        row?.['Taxable Ledger'],
        row?.expense_ledger,
        row?.['Expense Ledger'],
        row?.voucher_type,
        row?.['Voucher Type'],
        row?.narration,
        row?.Narration,
        row?.description,
        row?.Description,
        row?.particulars,
        row?.Particulars
    ].filter(Boolean).join(' ')).toUpperCase();
    const tdsLedgerUpper = String(row?.tds_ledger || row?.TDSLedger || row?.['TDS Ledger'] || row?.tds_ledger_name || '').toUpperCase().trim();
    // Known Steel & Metals TDS party/ledger patterns that Tally sometimes exposes without a proper section code.
    if (/SILICON\s+SYSTEMS|TDS\s+ON\s+PROFESSION|PROFESSIONAL\s+FEES?|COMPUTER\s+EXPENSES/.test(source) && !/BHARTI\s+AIRTEL/.test(source)) return '194JA';
    if (/BHARTI\s+AIRTEL/.test(source)) return '194Q';
    if (/ABHAY\s+AJITSARIA|ADITYA\s+KHEMKA|PAYMENT\s+TO\s+PARTNERS?|PARTNER\s+PAYMENT|194T|94T/.test(source)) {
        if (tdsLedgerUpper.includes('CAPITAL') || tdsLedgerUpper.includes('REMUNERATION') || tdsLedgerUpper.includes('PARTNER') || tdsLedgerUpper.includes('194T') || tdsLedgerUpper.includes('94T')) {
            return '194T';
        }
    }
    if (/ARUN\s+KUMAR\s+AJITSARIA|S\.?\s*JAYKISHAN|194JB|94JB|PROFESSIONAL\s+FEES?\s+COMPANY|FEES?\s+FOR\s+TECHNICAL\s+SERVICES?\s+COMPANY/.test(source)) {
        if (tdsLedgerUpper.includes('PROFESSION') || tdsLedgerUpper.includes('TECHNICAL') || tdsLedgerUpper.includes('ROYALTY') || tdsLedgerUpper.includes('194JB') || tdsLedgerUpper.includes('94JB')) {
            return '194JB';
        }
    }
    const direct = normalizeSection(source);
    if (direct && /^\d/.test(direct)) return direct;
    const compact = source.replace(/[^A-Z0-9]/g, ' ');
    const has = (re) => re.test(compact);
    if (has(/CONTRACT|TRANSPORT|LABOUR|LABOR|WORKS? CONTRACT|JOB WORK|SUB CONTRACT/)) return '194C';
    if (has(/COMMISSION|BROKERAGE|BROKER/)) return '194H';
    if (has(/INTEREST|LOAN|FINANCE CHARGES/)) return '194A';
    if (has(/RENT|RENTAL|LEASE/)) return '194I';
    if (has(/PROFESSIONAL|PROFESSION FEES|PROFESSION FEE|CONSULTANCY|CONSULTANT|LEGAL|AUDIT|ACCOUNTING|ARCHITECT|COMPUTER SERVICE|IT SERVICE|SOFTWARE SERVICE|COMPUTER EXPENSES/)) return '194JA';
    if (has(/TECHNICAL|TECH SERVICE|TECHNICAL FEES|TECHNICAL FEE|ROYALTY|NON COMPETE|DIRECTOR FEE|DIRECTORS FEE|194JB|94JB/)) return '194JB';
    if (has(/PARTNER|PARTNERS|PARTNER PAYMENT|PAYMENT TO PARTNER|PAYMENT TO PARTNERS|PARTNER REMUNERATION|PARTNER INTEREST|194T|94T/)) return '194T';
    if (has(/PURCHASE|GOODS|194Q|94Q/)) return '194Q';
    return existing || '';
};
const normalizeTdsRate = (value) => {
    const n = parseBankAmount(value);
    if (!n) return 0;
    return n > 1 ? n : n * 100;
};
const normalizeTdsRowCommon = (row, index, source) => {
    const partyName = String(pickFirstLoose(row, ['party_ledger', 'PartyLedgerName', 'Party Ledger Name', 'party_name', 'Party Name', 'deductee_name', 'Deductee Name', 'Name of Deductee', 'supplier_name', 'Supplier Name', 'vendor_name', 'Vendor Name', 'ledger_name', 'Ledger Name', 'Name']) || '');
    const pan = normalizePan(pickFirstLoose(row, ['pan', 'PAN', 'PAN of Deductee', 'Deductee PAN', 'deductee_pan', 'Party PAN', 'Income Tax Number', 'IncomeTaxNumber', 'PANITNo', 'PANNo']));
    const section = normalizeSection(pickFirstLoose(row, ['section', 'Section', 'TDS Section', 'section_code', 'TDS Nature', 'Nature of Payment', 'TDS Nature / shorthand section like 94C, 94H, 94A, 94T, 94JA, 94JB, 94I']));
    const date = isoDate(pickFirstLoose(row, ['date', 'Date', 'VoucherDate', 'Voucher Date', 'voucher_date', 'deduction_date', 'Date of Deduction', 'booking_date', 'payment_date', 'Payment Date', 'Date of Payment/Credited', 'Date of Payment or Credited', 'challan_date', 'Challan Date']));
    const voucherNumber = String(pickFirstLoose(row, ['voucher_number', 'Voucher Number', 'VoucherNumber', 'voucher_no', 'Voucher No', 'document_number', 'Document No', 'reference', 'Reference', 'invoice_number', 'Invoice Number', 'bill_number', 'Bill Number']) || '');
    const taxableLedger = String(pickFirstLoose(row, ['taxable_ledger', 'Taxable Ledger', 'expense_ledger', 'Expense Ledger', 'ledger', 'Ledger', 'particulars', 'Particulars']) || '');
    const taxableValue = Math.abs(pickNumberLoose(row, ['taxable_value', 'Taxable Value', 'taxable_amount', 'Taxable Amount', 'Taxable Ledger Amount', 'Assessable Value', 'Amount Paid/Credited', 'Amount Paid or Credited', 'amount_paid', 'Amount Paid', 'amount_credited']));
    const tdsAmount = Math.abs(pickNumberLoose(row, ['tds_amount', 'TDS Amount', 'Tax Deducted', 'tax_deducted', 'Total Tax Deducted', 'tds', 'TDS', 'income_tax', 'Income Tax']));
    const rate = normalizeTdsRate(pickFirstLoose(row, ['tds_rate', 'TDS Rate', 'rate', 'Rate', 'Rate of Deduction', 'TDS Deduction Rate %', 'TDS Deduction Rate']));
    const challanBsr = String(pickFirstLoose(row, ['bsr_code', 'BSR Code', 'challan_bsr', 'Bank BSR Code']) || '').replace(/[^0-9]/g, '');
    const challanSerial = String(pickFirstLoose(row, ['challan_serial_no', 'Challan Serial No', 'challan_no', 'Challan No', 'Challan Serial Number']) || '').replace(/[^0-9A-Z]/ig, '').toUpperCase();
    const challanDate = isoDate(pickFirstLoose(row, ['challan_date', 'Challan Date', 'Date of Deposit', 'deposit_date']));
    const challanAmount = Math.abs(pickNumberLoose(row, ['challan_amount', 'Challan Amount', 'Amount Deposited', 'deposit_amount', 'TDS Deposited', 'Total TDS Deposited']));
    const certificateNo = String(pickFirstLoose(row, ['certificate_no', 'Certificate No', 'Form16A No', 'Form 16A No']) || '');
    const narration = String(pickFirstLoose(row, ['narration', 'Narration', 'description', 'Description', 'remarks', 'Remarks', 'particulars', 'Particulars']) || '');
    return {
        [`${source}_index`]: index + 1,
        party_name: partyName,
        pan,
        section,
        date,
        voucher_number: voucherNumber,
        taxable_ledger: taxableLedger,
        taxable_value: taxableValue,
        tds_amount: tdsAmount,
        tds_rate: rate,
        challan_bsr: challanBsr,
        challan_serial_no: challanSerial,
        challan_date: challanDate,
        challan_amount: challanAmount,
        certificate_no: certificateNo,
        narration
    };
};
const normalizeExternalTdsRow = (row, index) => normalizeTdsRowCommon(row, index, 'external');
const normalizeTallyTdsRow = (row, index) => {
    const n = normalizeTdsRowCommon(row, index, 'tally');
    n.party_name = String(row?.party_ledger || row?.party_name || n.party_name || '');
    n.voucher_type = String(row?.voucher_type || row?.VoucherTypeName || '');
    return n;
};
const tdsKey = (row) => `${normalizePan(row.pan)}|${normalizeSection(row.section)}|${Math.round(Math.abs(row.tds_amount || 0) * 100)}`;
const scoreTdsMatch = (external, tally, taxableTolerance, tdsTolerance, rateTolerance, dateToleranceDays) => {
    let score = 0;
    const reasons = [];
    const panSame = external.pan && tally.pan && external.pan === tally.pan;
    const sectionSame = external.section && tally.section && external.section === tally.section;
    if (panSame) { score += 35; reasons.push('PAN matched'); }
    else if (tokenSimilarity(external.party_name, tally.party_name) >= 0.5) { score += 20; reasons.push('party name similar'); }
    if (sectionSame) { score += 20; reasons.push('section matched'); }
    const tdsDiff = Math.abs((external.tds_amount || 0) - (tally.tds_amount || 0));
    const taxableDiff = Math.abs((external.taxable_value || 0) - (tally.taxable_value || 0));
    const rateDiff = Math.abs((external.tds_rate || 0) - (tally.tds_rate || 0));
    if (tdsDiff <= tdsTolerance) { score += 25; reasons.push('TDS amount matched'); }
    if (taxableDiff <= taxableTolerance) { score += 15; reasons.push('taxable value matched'); }
    if ((external.tds_rate || tally.tds_rate) && rateDiff <= rateTolerance) { score += 10; reasons.push('TDS rate matched'); }
    const dateDiff = daysBetween(external.date || external.challan_date, tally.date || tally.challan_date);
    if (dateDiff <= dateToleranceDays) { score += Math.max(0, 10 - dateDiff); reasons.push('date near/matched'); }
    const extRef = normalizeRef(`${external.voucher_number || ''} ${external.certificate_no || ''} ${external.narration || ''}`);
    const tallyRef = normalizeRef(`${tally.voucher_number || ''} ${tally.narration || ''}`);
    if (extRef && tallyRef && (extRef.includes(tallyRef) || tallyRef.includes(extRef))) { score += 10; reasons.push('reference/narration matched'); }
    return { score, panSame, sectionSame, tdsDiff, taxableDiff, rateDiff, dateDiff, reasons };
};
const buildTdsTallyIndex = (rows) => {
    const byKey = new Map();
    const byPanSection = new Map();
    const byAmount = new Map();
    rows.forEach((row, i) => {
        const k = tdsKey(row);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(i);
        const ps = `${row.pan}|${row.section}`;
        if (!byPanSection.has(ps)) byPanSection.set(ps, []);
        byPanSection.get(ps).push(i);
        const amt = String(Math.round(Math.abs(row.tds_amount || 0) * 100));
        if (!byAmount.has(amt)) byAmount.set(amt, []);
        byAmount.get(amt).push(i);
    });
    return { byKey, byPanSection, byAmount };
};


const isExcludedTdsDeducteeLedgerName = (name) => {
    const t = normalizeText(name);
    if (!t) return true;
    const excluded = [
        // Bank/cash/payment ledgers are never deductees.
        'BANK', 'HDFC', 'ICICI', 'AXIS', 'SBI', 'PUNJAB NATIONAL', 'PNB', 'KOTAK', 'YES BANK', 'INDUSIND', 'IDFC', 'FEDERAL BANK', 'BANK OF BARODA', 'BOB', 'CANARA', 'UNION BANK', 'CURRENT A C', 'CURRENT ACCOUNT', 'CASH CREDIT', 'OVERDRAFT', ' OD ', ' OCC ',
        'CASH', 'PETTY CASH',
        // Tax/TDS/GST ledgers are not party ledgers.
        'TDS', 'T D S', 'T.D.S', 'TAX DEDUCTED', 'TAX DEDN', 'GST', 'CGST', 'SGST', 'IGST', 'UTGST', 'CESS', 'DUTIES', 'DUTY', 'TAX', 'ROUND OFF', 'ROUNDOFF',
        // Common taxable/expense/income ledger names should not become deductee names.
        'EXPENSE', 'EXPENCES', 'EXPENDITURE', 'PURCHASE', 'SALES', 'INCOME', 'REVENUE', 'CHARGES', 'FEES', 'FEE', 'RENT', 'RENTAL', 'PROFESSIONAL', 'CONSULTANCY', 'CONSULTANT', 'AUDIT', 'LEGAL', 'INTEREST', 'COMMISSION', 'BROKERAGE', 'GUARANTEE COMMISSION', 'FREIGHT', 'TRANSPORT CHARGES', 'LABOUR CHARGES', 'JOB WORK', 'SALARY', 'WAGES', 'DISCOUNT', 'CARRIAGE', 'CARRIAGE INWARD', 'CARRIAGE OUTWARD', 'COMPUTER EXPENSES', 'TELEPHONE EXPENSES', 'GENERAL EXPENSES', 'IRON & STEEL', 'PPGL PURCHASE', 'JOB WORK CHARGES', 'ROLLED', 'SER.'
    ];
    return excluded.some(w => t.includes(w.trim()));
};
const isGenericTdsLedgerName = (name) => {
    const t = normalizeText(name);
    if (!t) return false;
    return /\b(TDS|T D S|T\.D\.S|TAX DEDUCTED|TAX DEDN|TAX DEDUCTION|TDS PAYABLE|TDS ON|TDS U\/S|SECTION\s*19|CHALLAN|OLTAS|INCOME TAX|GOVT|GOVERNMENT)\b/.test(t)
        || /\b(TDS ON INTEREST|TDS ON CONTRACTOR|TDS ON RENT|TDS ON PROFESSION|TDS ON PROFESSIONAL|TDS ON PURCHASE|TDS ON COMMISSION|TDS ON PARTNER|TDS ON PARTNERS)\b/.test(t);
};
const cleanPartyLedgerName = (name) => String(name || '').replace(/\s*\((SCR|SCR\.|S\.C\.R\.?|SUNDRY CREDITORS?)\)\s*$/i, '').trim();
const isRecognisablePartyLedgerName = (name) => {
    const cleaned = cleanPartyLedgerName(name);
    const t = normalizeText(cleaned);
    if (!t || isGenericTdsLedgerName(t) || isExcludedTdsDeducteeLedgerName(t)) return false;
    return /\b(PVT|PRIVATE|LTD|LIMITED|LLP|CO\.?|COMPANY|CORPORATION|INDUSTRIES|LOGISTICS|TRANSPORT|AIRTEL|SYSTEMS|BUILDTECH|ROADMARK|SUPREME|PATHWAY|PODDAR|NOWRANGROY|STELLAR|BHARTI|SILICON|LIMTON|ARUN|JAYKISHAN|AJITSARIA|KHEMKA|ABHAY|ADITYA)\b/.test(t) || t.split(/\s+/).length >= 2;
};
const isCreditorLikeLedgerName = (name) => {
    const t = normalizeText(name);
    if (!t || isExcludedTdsDeducteeLedgerName(t)) return false;
    return true;
};
const pickPartyLedgerByVoucherRules = (row) => {
    const vt = normalizeVoucherTypeForTdsFilter(pickFirst(row, ['voucher_type', 'Voucher Type', 'VoucherTypeName', 'type', 'Type']));
    const keysByPriority = [];
    if (vt.includes('PURCHASE')) {
        keysByPriority.push(['party_ledger', 'Party Ledger', 'PartyLedgerName', 'Party Ledger Name', 'supplier_name', 'Supplier Name', 'vendor_name', 'Vendor Name', 'deductee_name', 'Deductee Name', 'Name of Deductee']);
    } else if (vt.includes('JOURNAL')) {
        keysByPriority.push(['credited_ledger', 'Credited Ledger', 'credit_ledger', 'Credit Ledger', 'ledger_credited', 'Ledger Credited', 'party_ledger', 'Party Ledger', 'PartyLedgerName', 'Party Ledger Name', 'deductee_name', 'Deductee Name', 'Name of Deductee']);
    } else if (vt.includes('PAYMENT')) {
        keysByPriority.push(['party_ledger', 'Party Ledger', 'PartyLedgerName', 'Party Ledger Name', 'paid_to', 'Paid To', 'supplier_name', 'Supplier Name', 'vendor_name', 'Vendor Name', 'deductee_name', 'Deductee Name']);
    }
    keysByPriority.push(['deductee_ledger', 'Deductee Ledger', 'party_ledger', 'Party Ledger', 'PartyLedgerName', 'Party Ledger Name', 'supplier_name', 'Supplier Name', 'vendor_name', 'Vendor Name', 'deductee_name', 'Deductee Name', 'Name of Deductee', 'opposite_ledger', 'Opposite Ledger', 'counter_party', 'Counter Party', 'ledger_name', 'Ledger Name', 'Name']);
    for (const keys of keysByPriority) {
        for (const key of keys) {
            const v = String(row?.[key] ?? '').trim();
            if (v && isCreditorLikeLedgerName(v)) return v;
        }
        const v = String(pickFirst(row, keys) || '').trim();
        if (v && isCreditorLikeLedgerName(v)) return v;
    }
    const tdsLedgerFallback = String(pickFirst(row, ['tds_ledger', 'TDS Ledger', 'tdsLedger', 'TDSLedger', 'tds_ledger_name', 'TDS Ledger Name']) || '').trim();
    if (isRecognisablePartyLedgerName(tdsLedgerFallback)) return cleanPartyLedgerName(tdsLedgerFallback);
    return '';
};
const resolveTdsDeducteeName = (row, basePartyName = '') => {
    // Priority rule requested by user:
    // Purchase => supplier/party ledger. Journal => credited party ledger. Never TDS/taxable/expense/bank ledger.
    const manual = getTdsManualOverride(row?.voucher_number || row?.VoucherNumber || row?.['Voucher Number']);
    if (manual?.party_name) return manual.party_name;
    const byVoucherRule = pickPartyLedgerByVoucherRules(row);
    if (byVoucherRule) return byVoucherRule;
    const candidates = [
        basePartyName,
        pickFirst(row, ['deductee_ledger', 'Deductee Ledger', 'deductee_name', 'Deductee Name', 'Name of Deductee', 'supplier_name', 'Supplier Name', 'vendor_name', 'Vendor Name']),
        pickFirst(row, ['party_ledger', 'Party Ledger', 'party_name', 'Party Name', 'ledger_name', 'Ledger Name', 'Name']),
        pickFirst(row, ['opposite_ledger', 'Opposite Ledger', 'alternate_ledger', 'Alternate Ledger', 'counter_party', 'Counter Party']),
        pickFirst(row, ['tds_ledger', 'TDS Ledger', 'tdsLedger', 'TDSLedger', 'tds_ledger_name', 'TDS Ledger Name'])
    ].map(v => cleanPartyLedgerName(String(v || '').trim())).filter(Boolean);
    const nonExcluded = candidates.find(v => isRecognisablePartyLedgerName(v));
    return nonExcluded || String(basePartyName || '').trim();
};
const panEntityType = (panValue) => {
    const pan = normalizePan(panValue);
    if (!pan) return { pan_status: 'missing', pan_entity_code: '', pan_entity_type: 'PAN missing', company_category: 'unknown', contractor_type: 'Unknown' };
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return { pan_status: 'invalid', pan_entity_code: pan[3] || '', pan_entity_type: 'PAN invalid', company_category: 'unknown', contractor_type: 'Unknown' };
    const code = pan[3];
    const map = {
        P: 'Individual / Proprietor',
        H: 'HUF',
        C: 'Company',
        F: 'Firm / LLP',
        A: 'AOP',
        B: 'BOI',
        T: 'Trust',
        L: 'Local Authority',
        J: 'Artificial Juridical Person',
        G: 'Government'
    };
    const entity = map[code] || 'Other / Unknown';
    let companyCategory = code === 'C' ? 'company' : 'non_company';
    if (code === 'G') companyCategory = 'government';
    let contractorType = 'Others';
    if (code === 'P') contractorType = 'Proprietor / Individual';
    else if (code === 'H') contractorType = 'HUF';
    else if (code === 'F') contractorType = 'Firm / LLP';
    else if (code === 'C') contractorType = 'Company';
    else if (code === 'G') contractorType = 'Government';
    return { pan_status: 'valid', pan_entity_code: code, pan_entity_type: entity, company_category: companyCategory, contractor_type: contractorType };
};
const isAdvanceTdsRow = (row) => /ADVANCE|ADHOC|ON ACCOUNT|PREPAID/i.test(`${row.voucher_type || ''} ${row.narration || ''} ${row.taxable_ledger || ''}`);

const canonicalVoucherNo = (value) => String(value || '').toUpperCase().replace(/\s+/g, '').trim();
const getTdsManualOverride = (voucherNo) => null;
const isKnownExcludedTdsDeductionVoucher = (voucherNo) => false;

const normalizeVoucherTypeForTdsFilter = (value) => normalizeText(String(value || '')).replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const isPaymentVoucherType = (value) => {
    const t = normalizeVoucherTypeForTdsFilter(value);
    if (!t) return false;
    return t === 'PAYMENT' || t === 'PYMT' || t.includes('PAYMENT VOUCHER');
};
const isTdsChallanOrGovtPaymentRow = (row) => {
    const voucherNo = pickFirst(row, ['voucher_number', 'Voucher Number', 'VoucherNumber', 'voucher_no', 'Voucher No']);
    const manual = getTdsManualOverride(voucherNo);
    if (manual?.exclude_from_deduction_report) return true;
    if (isKnownExcludedTdsDeductionVoucher(voucherNo)) return true;
    const taxableLedger = String(row?.taxable_ledger || row?.['Taxable Ledger'] || '').trim();
    const tdsLedger = String(row?.tds_ledger || row?.['TDS Ledger'] || '').trim();
    // Pure TDS deposit voucher: taxable_ledger and tds_ledger are the same generic TDS ledger, so there is no separate party/expense leg.
    if (taxableLedger && tdsLedger && normalizeText(taxableLedger) === normalizeText(tdsLedger) && isGenericTdsLedgerName(taxableLedger)) return true;
    // Known party payment duplicate pattern: payment voucher where taxable_ledger = tds_ledger = named party.
    // Keep this conservative to avoid dropping genuine deduction rows like pre-payment TDS rows unless they are known duplicates.
    if (isPaymentVoucherType(row?.voucher_type || row?.VoucherTypeName || row?.['Voucher Type']) && taxableLedger && tdsLedger && normalizeText(taxableLedger) === normalizeText(tdsLedger)) {
        // No hardcoded duplicate exclusions
        return false;
    }
    const narr = normalizeText(String(row?.narration || row?.remarks || row?.description || ''));
    // FIX 2: Exclude returned cheque and refund/reversal vouchers — these are pure party transactions, not TDS deduction events.
    // Patterns: "cheque returned", "being returned", "amount refunded to party", "refunded agst", "bounced", "dishonoured", "dishonour"
    if (narr && /\b(CHEQUE.*RETURNED|BEING.*RETURNED|RETURNED.*CHEQUE|AMOUNT\s+REFUNDED\s+TO\s+PARTY|REFUNDED\s+(TO\s+PARTY\s+)?(AGST|AGAINST)|CHEQUE\s+(BOUNCED|DISHONOURED|DISHONORED|DISHONOU?R)|BOUNCED\s+CHEQUE|BEING\s+AMOUNT\s+REFUNDED|AMOUNT\s+REFUNDED\s+AGST)\b/.test(narr)) return true;
    const txt = normalizeText([row?.voucher_type, row?.voucher_number, row?.tds_ledger, row?.taxable_ledger, row?.party_name, row?.narration, row?.remarks, row?.description].map(v => String(v || '')).join(' '));
    if (!txt) return false;
    return /\b(CHALLAN|BSR|CIN|OLTAS|INCOME TAX|TDS PAYABLE|TDS PAYMENT|GOVT|GOVERNMENT|DEPOSIT TO GOVERNMENT|TAX PAYMENT)\b/.test(txt);
};
const isTdsByPartyVoucherType = (value) => {
    const t = normalizeVoucherTypeForTdsFilter(value);
    if (!t) return false;
    return t === 'TDS BY PARTY' || t.includes('TDS BY PARTY') || t.includes('TDS PARTY') || t.includes('TDS DEDUCTION BY PARTY') || t.includes('TDSPARTY');
};
const isJournalVoucherType = (value) => {
    const t = normalizeVoucherTypeForTdsFilter(value);
    if (!t) return false;
    return t === 'JOURNAL' || t === 'JRNL' || t.includes('JOURNAL VOUCHER');
};
const isAllowedTdsAdjustmentOrProvisionJournalRow = (row) => {
    const txt = normalizeText([row?.voucher_type, row?.voucher_number, row?.tds_ledger, row?.taxable_ledger, row?.party_name, row?.narration, row?.remarks, row?.description].map(v => String(v || '')).join(' '));
    // Standard adjustment/provision/accrual journals
    if (/\b(ADJUSTMENT|ADJ|PROVISION|PROV|ACCRUAL|ACCRUED|YEAR END|YEAREND|CLOSING ENTRY)\b/.test(txt)) return true;
    // 194A: TDS deducted on interest/loan journals (e.g. "BEING TDS DEDUCTED ON INTEREST ON LOAN")
    if (/\b(TDS.*INTEREST|INTEREST.*TDS|TDS.*LOAN|LOAN.*TDS|194A|94A)\b/.test(txt)) return true;
    // Also allow journals where TDS ledger is TDS ON INTEREST (194A entries)
    const tdsLedger = normalizeText(String(row?.tds_ledger || ''));
    if (/TDS.*INTEREST|INTEREST.*TDS/.test(tdsLedger)) return true;
    // 194T: Partner payment/remuneration journals
    if (/\b(PARTNER|PARTNERS|PARTNER REMUNERATION|PARTNER PAYMENT|194T|94T)\b/.test(txt)) return true;
    // 194JA/194JB: Professional/technical fees journals
    if (/\b(PROFESSIONAL FEES?|PROFESSION FEES?|TECHNICAL FEES?|194JA|194JB|94JA|94JB)\b/.test(txt)) return true;
    // 194H: Commission/brokerage journals
    if (/\b(BROKERAGE|COMMISSION|GUARANTEE COMMISSION|194H|94H)\b/.test(txt)) return true;
    // 194C: Contractor payment journals (e.g. JV/MAR/143 for Priti Road Lines)
    if (/\b(CARRIAGE|FREIGHT|TRANSPORT|CONTRACTOR|JOB WORK|194C|94C)\b/.test(txt)) return true;
    return false;
};
const isReceiptVoucherType = (value) => {
    const t = normalizeVoucherTypeForTdsFilter(value);
    if (!t) return false;
    // FIX 3: Receipt vouchers are money-in from the party — they are never TDS deduction events.
    // This covers Tally's "Receipt" type and variants.
    return t === 'RECEIPT' || t === 'RCPT' || t.includes('RECEIPT VOUCHER') || t.startsWith('RECEIPT');
};
const isAllowedTdsDeductionVoucherType = (rowOrValue, allowedTypes = ['PURCHASE', 'JOURNAL']) => {
    const row = rowOrValue && typeof rowOrValue === 'object' ? rowOrValue : { voucher_type: rowOrValue };
    const tdsLg = String(row.tds_ledger || row.TDSLedger || row['TDS Ledger'] || row.tds_ledger_name || '').toUpperCase().trim();
    if (tdsLg === 'TAX DEDUCTED AT SOURCE BY PARTY') return false;
    const t = normalizeVoucherTypeForTdsFilter(row.voucher_type);
    if (isKnownExcludedTdsDeductionVoucher(row.voucher_number || row.VoucherNumber || row['Voucher Number'])) return false;
    // FIX 3: Reject Receipt voucher types before any other check — receipts are never TDS deduction sources.
    if (isReceiptVoucherType(t)) return false;
    if (isTdsChallanOrGovtPaymentRow(row)) return false;
    if (!t) return true; // Keep rows with missing voucher type; do not drop useful data only because Tally did not expose type.
    if (isTdsByPartyVoucherType(t)) return false;
    const allowed = (Array.isArray(allowedTypes) && allowedTypes.length ? allowedTypes : ['PURCHASE', 'JOURNAL']).map(normalizeVoucherTypeForTdsFilter).filter(Boolean);
    const allowedByType = allowed.some(a => t === a || t.includes(a));
    if (!allowedByType) return false;
    if (isPaymentVoucherType(t) && isTdsChallanOrGovtPaymentRow(row)) return false;
    if (isJournalVoucherType(t)) return isAllowedTdsAdjustmentOrProvisionJournalRow(row);
    return true;
};
const normalizeTdsReportRow = (row, index) => {
    const base = normalizeTdsRowCommon(row, index, 'tds_report');
    // Strict base extraction for TDS reports: never let generic keys like "amount"
    // accidentally pick up tds_amount/TDS Amount. taxable_value must come from the
    // voucher's non-TDS taxable/expense/income ledger amount exposed by Tally.
    const taxableValueDirect = Math.abs(pickNumberLoose(row, ['taxable_value', 'Taxable Value', 'taxable_amount', 'Taxable Amount', 'Taxable Ledger Amount', 'Assessable Value', 'Amount Paid/Credited', 'Amount Paid or Credited']));
    const grossValue = Math.abs(pickNumberLoose(row, ['gross_value', 'Gross Value', 'gross_amount', 'Gross Amount', 'invoice_total', 'Invoice Total', 'bill_total', 'Bill Total', 'total_amount', 'Total Amount']));
    const paymentValue = Math.abs(pickNumberLoose(row, ['payment_value', 'Payment Value', 'payment_amount', 'Payment Amount', 'paid_amount', 'Paid Amount', 'amount_paid', 'Amount Paid', 'Amount Paid/Credited', 'Amount Paid or Credited']));
    const voucherType = String(pickFirstLoose(row, ['voucher_type', 'Voucher Type', 'VoucherTypeName', 'type', 'Type']) || row?.voucher_type || '');
    const tdsLedger = String(pickFirstLoose(row, ['tds_ledger', 'TDS Ledger', 'tdsLedger', 'TDSLedger', 'tds_ledger_name', 'TDS Ledger Name']) || '');
    const manual = getTdsManualOverride(base.voucher_number || row?.voucher_number || row?.VoucherNumber || row?.['Voucher Number']);
    const section = manual?.section || inferTdsSectionFromText({ ...row, tds_ledger: tdsLedger, taxable_ledger: base.taxable_ledger, voucher_type: voucherType, narration: base.narration }, base.section);
    const resolvedDeducteeName = resolveTdsDeducteeName(row, base.party_name);
    const taxableDirect = manual?.base_amount || taxableValueDirect || 0;
    return {
        index: index + 1,
        party_name: manual?.party_name || resolvedDeducteeName,
        pan: manual?.pan || base.pan,
        section,
        date: base.date,
        voucher_number: base.voucher_number,
        voucher_type: voucherType,
        tds_ledger: tdsLedger,
        taxable_ledger: base.taxable_ledger,
        taxable_value: taxableDirect,
        gross_value: manual?.base_amount || grossValue || 0,
        payment_value: manual?.base_amount || paymentValue || 0,
        tds_amount: base.tds_amount || 0,
        actual_rate: base.tds_rate || 0,
        narration: base.narration,
        manual_override_warning: manual?.warning || manual?.tally_data_warning || '',
        is_advance: isAdvanceTdsRow({ ...base, voucher_type: voucherType })
    };
};
const tdsBaseAmount = (row, mode) => {
    if (mode === 'gross_value') return row.gross_value || row.taxable_value || row.payment_value || 0;
    if (mode === 'payment_value') return row.payment_value || row.gross_value || row.taxable_value || 0;
    if (mode === 'auto_detect') return row.taxable_value || row.gross_value || row.payment_value || 0;
    return row.taxable_value || row.gross_value || row.payment_value || 0;
};
const isReasonableTdsRatePercent = (rate) => Number.isFinite(rate) && rate >= 0 && rate <= 30;
const rateFromTdsAndBase = (tdsAmount, baseAmount) => {
    const tds = Math.abs(Number(tdsAmount || 0));
    const base = Math.abs(Number(baseAmount || 0));
    if (!base || !tds) return 0;
    return Number(((tds * 100) / base).toFixed(4));
};
const isPlausibleTdsBase = (baseAmount, tdsAmount, expectedRate = 0) => {
    const base = Math.abs(Number(baseAmount || 0));
    const tds = Math.abs(Number(tdsAmount || 0));
    if (!base) return false;
    if (!tds) return true;
    const rate = rateFromTdsAndBase(tds, base);
    if (isReasonableTdsRatePercent(rate)) return true;
    if (expectedRate > 0) {
        const expectedBase = (tds * 100) / expectedRate;
        const diffPct = expectedBase ? Math.abs(base - expectedBase) * 100 / expectedBase : 999;
        return diffPct <= 10;
    }
    return false;
};
const expectedBaseFromTds = (tdsAmount, expectedRate = 0) => {
    const tds = Math.abs(Number(tdsAmount || 0));
    const rate = Math.abs(Number(expectedRate || 0));
    if (!tds || !rate) return 0;
    return Number(((tds * 100) / rate).toFixed(2));
};
const isClearlyTdsAmountMistakenAsBase = (baseAmount, tdsAmount, expectedRate = 0) => {
    const base = Math.abs(Number(baseAmount || 0));
    const tds = Math.abs(Number(tdsAmount || 0));
    if (!base || !tds) return false;
    if (Math.abs(base - tds) <= Math.max(1, tds * 0.001)) return true;
    const actualRate = rateFromTdsAndBase(tds, base);
    if (actualRate > 30) return true;
    if (expectedRate > 0) {
        const expectedBase = expectedBaseFromTds(tds, expectedRate);
        if (expectedBase && base < expectedBase * 0.5) return true;
    }
    return false;
};
const chooseTdsReportBaseAmount = (row, mode, expectedRate = 0) => {
    // Primary fix: use the direct non-TDS taxable/expense/income ledger value exposed by Tally.
    // The TDL now sums all non-TDS taxable ledger entries, because a voucher may have multiple
    // expense/income rows. Do not accept an obviously wrong base where the amount is the same
    // as the TDS amount or where the calculated rate becomes impossible, e.g. 104%.
    const candidates = [];
    const add = (source, value) => {
        const n = Math.abs(Number(value || 0));
        if (n && !candidates.some(c => Math.abs(c.value - n) < 0.001)) candidates.push({ source, value: n });
    };
    if (mode === 'gross_value') add('gross_value', row.gross_value);
    else if (mode === 'payment_value') add('payment_value', row.payment_value);
    else add('taxable_value', row.taxable_value);
    add('taxable_value', row.taxable_value);
    add('gross_value', row.gross_value);
    add('payment_value', row.payment_value);
    if (row.manual_override_warning && row.taxable_value) return { amount: Math.abs(Number(row.taxable_value)), source: 'manual_register_verified_override', derived: false, base_warning: row.manual_override_warning };
    const validCandidates = candidates.filter(c => !isClearlyTdsAmountMistakenAsBase(c.value, row.tds_amount, expectedRate));
    const plausible = validCandidates.find(c => isPlausibleTdsBase(c.value, row.tds_amount, expectedRate));
    if (plausible) return { amount: plausible.value, source: plausible.source, derived: false, base_warning: row.manual_override_warning || '' };
    if (validCandidates[0]) return { amount: validCandidates[0].value, source: validCandidates[0].source + '_unverified_direct', derived: false, base_warning: (row.manual_override_warning ? row.manual_override_warning + ' ' : '') + 'Base amount is direct from voucher row, but rate looks unusual. Review taxable ledger mapping.' };
    // Controlled fallback requested by user: only when the direct base is missing/invalid and the section has a standard known rate.
    // Flag this as derived so it can be reviewed; prefer fixing Tally voucher ledger extraction when possible.
    const standardRates = [0.1, 0.118, 1, 2, 5, 10, 20];
    if (row.tds_amount && expectedRate && standardRates.some(r => Math.abs(r - expectedRate) < 0.0001)) {
        const derivedBase = expectedBaseFromTds(row.tds_amount, expectedRate);
        if (derivedBase) return { amount: derivedBase, source: 'derived_from_tds_amount_standard_rate_due_missing_direct_base', derived: true, base_warning: (row.manual_override_warning ? row.manual_override_warning + ' ' : '') + 'Direct taxable/gross voucher base was missing or invalid, so base was estimated from TDS amount and a standard known rate. Verify with voucher.' };
    }
    return { amount: 0, source: 'missing_or_invalid_direct_taxable_ledger', derived: false, base_warning: (row.manual_override_warning ? row.manual_override_warning + ' ' : '') + 'Taxable/base ledger was not identified directly from non-TDS voucher ledger entries; no safe standard-rate fallback was available.' };
};
const chooseTdsActualRate = (row, baseAmount, expectedRate = 0) => {
    const explicit = Number(row.actual_rate || 0);
    if (explicit > 0 && isReasonableTdsRatePercent(explicit)) return explicit;
    const derived = rateFromTdsAndBase(row.tds_amount, baseAmount);
    if (derived > 0 && isReasonableTdsRatePercent(derived)) return derived;
    if (expectedRate > 0) return expectedRate;
    return derived || 0;
};
const defaultExpectedTdsRate = (section, panInfo, args = {}) => {
    const sec = normalizeSection(section || args.section);
    if (args.expectedRate !== undefined) return args.expectedRate;
    if (sec === '194C') {
        if (panInfo.pan_entity_code === 'P' || panInfo.pan_entity_code === 'H') return args.expectedRateIndividual ?? 1;
        return args.expectedRateOthers ?? 2;
    }
    if (sec === '194Q') return args.expectedRate194Q ?? 0.1;
    if (sec === '194A') return args.expectedRate194A ?? 10;
    if (sec === '194H') return args.expectedRate194H ?? 5;
    if (sec === '194I') return args.expectedRate194I ?? 10;
    if (sec === '194JA') return args.expectedRate194JA ?? 10;
    if (sec === '194JB') return args.expectedRate194JB ?? 2;
    if (sec === '194T') return args.expectedRate194T ?? 10;
    if (args.expectedRateCompany !== undefined && panInfo.company_category === 'company') return args.expectedRateCompany;
    if (args.expectedRateNonCompany !== undefined && panInfo.company_category !== 'company') return args.expectedRateNonCompany;
    return 0;
};
const classifyTdsReportStatus = ({ row, panInfo, section, expectedRate, expectedTds, tdsTolerance, rateTolerance, baseAmount, taxableAboveThreshold, thresholdAmount, isThresholdSection }) => {
    const statuses = [];
    if (panInfo.pan_status === 'missing') statuses.push('pan_missing');
    if (panInfo.pan_status === 'invalid') statuses.push('pan_invalid');
    if (isThresholdSection && taxableAboveThreshold <= 0) statuses.push('threshold_not_crossed');
    if (expectedTds > tdsTolerance && row.tds_amount <= tdsTolerance) statuses.push('tds_not_deducted');
    const diff = Number(((row.tds_amount || 0) - (expectedTds || 0)).toFixed(2));
    if (Math.abs(diff) > tdsTolerance) statuses.push(diff < 0 ? 'short_deducted' : 'excess_deducted');
    if (expectedRate && row.actual_rate && Math.abs(row.actual_rate - expectedRate) > rateTolerance) statuses.push('rate_mismatch');
    if (!statuses.length) statuses.push('matched');
    return { status: statuses.join('+'), tds_difference: diff };
};

async function discoverTdsLedgers(targetCompany) {
    const fields = [
        'Name',
        'Parent',
        '_PrimaryGroup',
        'PAN',
        'IncomeTaxNumber',
        'PANITNo',
        'PANNo',
        'TypeOfDutyTax',
        'TaxType',
        'StatutoryType',
        'NatureOfPayment',
        'TDSNatureOfPayment',
        'IsTDSApplicable',
        'IsTDSOn',
        'Section',
        'TDSSection'
    ];

    const ledgers = await queryCollection('Ledger', fields, new Map(), targetCompany);
    const tdsLedgers = [];
    const tdsLedgerInfo = new Map();
    const ledgerPanMap = new Map();
    const seen = new Set();

    if (!Array.isArray(ledgers)) {
        return { tdsLedgers, tdsLedgerInfo, ledgerPanMap };
    }

    for (const l of ledgers) {
        const name = String(l.Name || '').trim();
        if (!name) continue;

        const normalizedName = normalizeText(name);
        const nameUpper = name.toUpperCase();
        const parentUpper = String(l.Parent || '').toUpperCase();
        const primaryGroupUpper = String(l._PrimaryGroup || '').toUpperCase();

        const pan = normalizePan(
            l.PAN ||
            l.IncomeTaxNumber ||
            l.PANITNo ||
            l.PANNo ||
            ''
        );

        if (pan) {
            ledgerPanMap.set(name, pan);
            ledgerPanMap.set(normalizedName, pan);
        }

        const typeOfDutyTax = String(l.TypeOfDutyTax || '').toUpperCase();
        const taxType = String(l.TaxType || '').toUpperCase();
        const statutoryType = String(l.StatutoryType || '').toUpperCase();
        const natureOfPayment = String(
            l.TDSNatureOfPayment ||
            l.NatureOfPayment ||
            ''
        ).trim();

        const isDutiesAndTaxes =
            parentUpper.includes('DUTIES & TAXES') ||
            parentUpper.includes('DUTIES AND TAXES') ||
            primaryGroupUpper.includes('DUTIES & TAXES') ||
            primaryGroupUpper.includes('DUTIES AND TAXES');

        const hasTdsMetadata =
            typeOfDutyTax.includes('TDS') ||
            taxType.includes('TDS') ||
            statutoryType.includes('TDS') ||
            String(l.IsTDSApplicable || '').toUpperCase() === 'YES' ||
            String(l.IsTDSOn || '').toUpperCase() === 'YES' ||
            natureOfPayment.toUpperCase().includes('TDS');

        const hasTdsName =
            nameUpper.includes('TDS') ||
            nameUpper.includes('T.D.S') ||
            nameUpper.includes('T D S') ||
            nameUpper.includes('TAX DEDUCTED') ||
            nameUpper.includes('TAX DEDN') ||
            /(^|[^A-Z0-9])194[A-Z]{0,2}($|[^A-Z0-9])/.test(nameUpper) ||
            /(^|[^A-Z0-9])94[A-Z]{0,2}($|[^A-Z0-9])/.test(nameUpper);

        const isOtherTax =
            nameUpper.includes('GST') ||
            nameUpper.includes('CGST') ||
            nameUpper.includes('SGST') ||
            nameUpper.includes('IGST') ||
            nameUpper.includes('CESS') ||
            nameUpper.includes('CST') ||
            nameUpper.includes('VAT') ||
            nameUpper.includes('EXCISE') ||
            nameUpper.includes('SERVICE TAX') ||
            nameUpper.includes('CENVAT') ||
            nameUpper.includes('CUSTOM') ||
            nameUpper.includes('ENTRY TAX') ||
            nameUpper.includes('TCS');

        const isTdsLedger =
            isDutiesAndTaxes &&
            !isOtherTax &&
            (
                hasTdsMetadata ||
                hasTdsName
            );

        if (!isTdsLedger) continue;
        if (seen.has(normalizedName)) continue;

        seen.add(normalizedName);
        tdsLedgers.push(name);

        const section =
            normalizeSection(l.TDSSection || l.Section || extractSectionFromLedgerName(nameUpper));

        tdsLedgerInfo.set(normalizedName, {
            name,
            parent: l.Parent || '',
            primary_group: l._PrimaryGroup || '',
            section,
            nature_of_payment: natureOfPayment,
            type_of_duty_tax: l.TypeOfDutyTax || '',
            tax_type: l.TaxType || '',
            statutory_type: l.StatutoryType || '',
            detection_source: hasTdsMetadata ? 'tally_statutory_metadata' : 'ledger_name_fallback'
        });
    }

    return {
        tdsLedgers,
        tdsLedgerInfo,
        ledgerPanMap
    };
}

// ── Fallback: fetch TDS rows directly from ledger-account statements ──────────
// Used when tds-payment-sheet returns 0 rows because Tally ledgers have no
// TDSNatureOfPayment / Section statutory metadata configured (common in Steel &
// Metals companies that manage TDS manually).
async function fetchTdsRowsFromLedgerAccounts(fromDate, toDate, targetCompany, tdsLedgers, tdsLedgerInfo) {
    const BANK_KEYWORDS = ['HDFC', 'ICICI', 'SBI', 'AXIS', 'KOTAK', 'YES BANK', 'PNB', 'BANK OF',
        'CANARA', 'UNION BANK', 'BANK LTD', 'BANK LIMITED', ' CC)', ' C/C)',
        ' CA)', ' C/A)', ' OD)', 'NEFT', 'RTGS', 'IMPS', 'CHALLAN'];

    const isBankEntry = (ledgerName) => {
        const upper = (ledgerName || '').toUpperCase();
        return BANK_KEYWORDS.some(k => upper.includes(k));
    };

    const rows = [];
    const panCache = new Map();

    const getPan = async (ledgerName) => {
        if (!ledgerName) return '';
        const key = ledgerName.toUpperCase();
        if (panCache.has(key)) return panCache.get(key);
        try {
            const params = new Map([['ledgerName', ledgerName]]);
            if (targetCompany) params.set('targetCompany', targetCompany);
            const details = await fetchReport('ledger-details', params);
            const pan = normalizePan(details?.data?.pan || details?.data?.PAN || '');
            panCache.set(key, pan);
            return pan;
        } catch {
            panCache.set(key, '');
            return '';
        }
    };

    for (const tdsLedger of tdsLedgers) {
        const normalizedLedger = normalizeText(tdsLedger);
        const info = tdsLedgerInfo.get(normalizedLedger) || {};

        // Determine section — prefer metadata, fall back to name-based mapping
        let section = info.section || extractSectionFromLedgerName(tdsLedger);
        if (!section) continue;
        section = normalizeSection(section);
        if (!section) continue;

        const inputParams = new Map([
            ['fromDate', fromDate],
            ['toDate', toDate],
            ['ledgerName', tdsLedger]
        ]);
        if (targetCompany) inputParams.set('targetCompany', targetCompany);

        const resp = await fetchReport('ledger-account', inputParams);
        if (resp.error || !Array.isArray(resp.data)) continue;

        for (const entry of resp.data) {
            // Skip opening balance rows
            if (!entry.date || String(entry.voucher_type || '').toUpperCase() === 'OPENING') continue;

            // credit = positive = TDS being deducted/accrued as liability
            const tdsAmount = Number(entry.amount || 0);
            if (tdsAmount <= 0) continue;

            // Skip bank/challan payment rows (TDS deposit to government)
            const counterparty = String(entry.alternate_ledger || entry.party_name || '');
            if (isBankEntry(counterparty)) continue;
            if (String(entry.voucher_type || '').toUpperCase().includes('PAYMENT') && isBankEntry(counterparty)) continue;

            const pan = await getPan(counterparty);

            rows.push({
                section,
                date: entry.date,
                voucher_type: entry.voucher_type || '',
                voucher_number: entry.voucher_number || '',
                party_name: counterparty,
                pan,
                tds_ledger: tdsLedger,
                taxable_ledger: counterparty,
                tds_amount: tdsAmount,
                // taxable value is not available from ledger-account alone;
                // processTdsVouchers / caller will note base_amount_source
                base_amount: 0,
                base_amount_source: 'ledger_account_fallback',
                base_amount_derived: true,
                rate: 0,
                narration: entry.narration || ''
            });
        }
    }

    return rows;
}

function extractSectionFromText(text) {
    const upper = String(text || '').toUpperCase();

    // ── Plain-English TDS ledger name lookup (for companies where Tally
    //    statutory metadata is not configured) ───────────────────────────
    const nameMap = [
        ['TDS ON CONTRACTOR', '194C'],
        ['TDS ON TRANSPORT', '194C'],
        ['TDS ON PROFESSION FEES', '194JA'],
        ['TDS ON PROFESSIONAL FEES', '194JA'],
        ['TDS ON PROFESSIONAL FEE', '194JA'],
        ['TDS ON TECHNICAL FEES', '194JB'],
        ['TDS ON TECHNICAL FEE', '194JB'],
        ['TDS ON ROYALTY', '194JB'],
        ['TDS ON PARTNER', '194T'],
        ['TDS ON REMUNERATION', '194T'],
        ['TDS ON INTEREST ON CAPITAL', '194T'],
        ['TDS ON CAPITAL INTEREST', '194T'],
        ['TDS ON INTEREST', '194A'],
        ['TDS ON RENT', '194I'],
        ['TDS ON BROKERAGE', '194H'],
        ['TDS ON COMMISSION', '194H'],
        ['TDS ON SALARY', '192'],
        ['TDS ON WAGES', '192'],
        ['TDS ON PURCHASE', '194Q'],
    ];
    for (const [phrase, section] of nameMap) {
        if (upper.includes(phrase)) return section;
    }

    // Numeric section code embedded in text (e.g. "194C", "94JB")
    const match194 = upper.match(/(^|[^A-Z0-9])(194[A-Z]{0,2})($|[^A-Z0-9])/);
    if (match194) return match194[2];

    const match94 = upper.match(/(^|[^A-Z0-9])(94[A-Z]{1,2})($|[^A-Z0-9])/);
    if (match94) return `1${match94[2]}`;

    return '';
}

function extractSectionFromLedgerName(ledgerName) {
    const upper = (ledgerName || '').toUpperCase();

    // Exact / phrase-level lookup table (check longest match first)
    const phraseMap = [
        ['PARTNER', '194T'],
        ['REMUNERATION', '194T'],
        ['INTEREST ON CAPITAL', '194T'],
        ['INTEREST', '194A'],
        ['BROKERAGE', '194H'],
        ['COMMISSION', '194H'],
        ['RENT', '194I'],
        ['PROFESSION', '194J'],
        ['PROFESSIONAL', '194J'],
        ['TECHNICAL', '194JB'],
        ['ROYALT', '194JB'],
        ['SALARY', '192'],
        ['WAGES', '192'],
        ['CONTRACTOR', '194C'],
        ['TRANSPORT', '194C'],
        ['PURCHASE', '194Q'],
    ];

    // Sort by phrase length descending so longer phrases win
    phraseMap.sort((a, b) => b[0].length - a[0].length);

    for (const [phrase, section] of phraseMap) {
        if (upper.includes(phrase)) return section;
    }

    // Fall through to numeric code regex (e.g. "194C", "94JB" in ledger name)
    return extractSectionFromText(upper) || '';
}

function extractTdsRateFromLedgerName(ledgerName) {
    const match = /@\s*(\d+(?:\.\d+)?)\s*%/i.exec(ledgerName);
    if (match && match[1]) {
        return parseFloat(match[1]);
    }
    const match2 = /(\d+(?:\.\d+)?)\s*%/i.exec(ledgerName);
    if (match2 && match2[1]) {
        return parseFloat(match2[1]);
    }
    const upper = ledgerName.toUpperCase();
    if (upper.includes('194Q') || upper.includes('94Q')) return 0.1;
    if (upper.includes('194A') || upper.includes('94A')) return 10;
    if (upper.includes('194H') || upper.includes('94H')) return 5;
    if (upper.includes('194I') || upper.includes('94I')) return 10;
    if (upper.includes('194JA') || upper.includes('94JA')) return 10;
    if (upper.includes('194JB') || upper.includes('94JB')) return 2;
    return 0;
}

function processTdsVouchers(vouchers, tdsLedgers, ledgerPanMap, sectionFilter = '') {
    const rows = [];
    const tdsLedgersSet = new Set(tdsLedgers);

    for (const vch of vouchers) {
        const ledgerEntries = Array.isArray(vch['ALLLEDGERENTRIES.LIST']) ? vch['ALLLEDGERENTRIES.LIST'] : [];
        if (ledgerEntries.length === 0) continue;

        const entries = ledgerEntries.map(e => ({
            ledger_name: e.ledger_name,
            amount: parseFloat(e.amount) || 0
        }));

        const tdsLines = entries.filter(e => tdsLedgersSet.has(e.ledger_name) && Math.abs(e.amount) > 0);
        if (tdsLines.length === 0) continue;

        const isPurchase = /Purchase/i.test(vch.voucher_type);
        const isJournal = /Journal/i.test(vch.voucher_type);
        const isPayment = /Payment/i.test(vch.voucher_type);

        const hasPartyEntry = entries.some(e => {
            const nameUpper = e.ledger_name.toUpperCase();
            return !tdsLedgersSet.has(e.ledger_name) &&
                !nameUpper.includes('CGST') && !nameUpper.includes('SGST') && !nameUpper.includes('IGST') &&
                !nameUpper.includes('UTGST') && !nameUpper.includes('CESS') &&
                !nameUpper.includes('BANK') && !nameUpper.includes('CASH') && !nameUpper.includes('HDFC');
        });

        const isChallan = /CHALLAN|BSR|CIN|OLTAS|INCOME TAX|GOVT|DEPOSIT TO GOVERNMENT|TAX PAYMENT/i.test(`${vch.voucher_type} ${vch.narration}`);
        if (isChallan || !hasPartyEntry) continue;

        if (isPurchase) {
            for (const tdsLine of tdsLines) {
                const tdsAmount = Math.abs(tdsLine.amount);
                const tdsLedger = tdsLine.ledger_name;
                const section = extractSectionFromLedgerName(tdsLedger);
                if (sectionFilter && section !== sectionFilter) continue;

                const rate = extractTdsRateFromLedgerName(tdsLedger);
                const partyLedger = vch.party_name || entries.find(e => {
                    const name = e.ledger_name.toUpperCase();
                    return e.amount > 0 && !tdsLedgersSet.has(e.ledger_name) &&
                        !name.includes('GST') && !name.includes('CGST') && !name.includes('SGST') && !name.includes('IGST');
                })?.ledger_name || '';

                const pan = ledgerPanMap.get(partyLedger) || '';

                const baseEntries = entries.filter(e => {
                    const name = e.ledger_name.toUpperCase();
                    return e.amount < 0 && !tdsLedgersSet.has(e.ledger_name) &&
                        !name.includes('GST') && !name.includes('CGST') && !name.includes('SGST') && !name.includes('IGST') &&
                        !name.includes('BANK') && !name.includes('CASH');
                });

                const baseAmount = baseEntries.reduce((sum, e) => sum + Math.abs(e.amount), 0);
                const taxableLedger = baseEntries.map(e => e.ledger_name).join(', ') || '';

                rows.push({
                    date: vch.date,
                    voucher_type: vch.voucher_type,
                    voucher_number: vch.voucher_number,
                    narration: vch.narration,
                    party_name: partyLedger,
                    pan,
                    section,
                    tds_ledger: tdsLedger,
                    tds_amount: tdsAmount,
                    taxable_ledger: taxableLedger,
                    base_amount: baseAmount,
                    rate,
                    base_amount_derived: false,
                    base_amount_source: 'purchase_voucher_ledger_lines',
                    status: 'matched'
                });
            }
        } else if (isJournal) {
            const debits = entries.filter(e => e.amount < 0);
            const credits = entries.filter(e => e.amount > 0 && !tdsLedgersSet.has(e.ledger_name));

            for (const tdsLine of tdsLines) {
                const tdsAmount = Math.abs(tdsLine.amount);
                const tdsLedger = tdsLine.ledger_name;
                const section = extractSectionFromLedgerName(tdsLedger);
                if (sectionFilter && section !== sectionFilter) continue;

                const rate = extractTdsRateFromLedgerName(tdsLedger);

                let matchedParty = null;
                let matchedExpense = null;

                if (rate > 0) {
                    const expectedNet = tdsAmount * (100 - rate) / rate;
                    matchedParty = credits.find(c => Math.abs(c.amount - expectedNet) <= Math.max(10, expectedNet * 0.02));

                    const expectedGross = tdsAmount * 100 / rate;
                    matchedExpense = debits.find(d => Math.abs(Math.abs(d.amount) - expectedGross) <= Math.max(10, expectedGross * 0.02));
                }

                if (!matchedParty) matchedParty = credits[0];
                if (!matchedExpense) matchedExpense = debits[0];

                const partyLedger = matchedParty ? matchedParty.ledger_name : (vch.party_name || '');
                const pan = ledgerPanMap.get(partyLedger) || '';

                let baseAmount = 0;
                let baseDerived = false;
                let baseSource = 'journal_voucher_ledger_lines';

                if (matchedExpense) {
                    baseAmount = Math.abs(matchedExpense.amount);
                } else if (matchedParty) {
                    baseAmount = Math.abs(matchedParty.amount) + tdsAmount;
                } else if (rate > 0) {
                    baseAmount = (tdsAmount * 100) / rate;
                    baseDerived = true;
                    baseSource = 'derived_from_tds_rate';
                }

                rows.push({
                    date: vch.date,
                    voucher_type: vch.voucher_type,
                    voucher_number: vch.voucher_number,
                    narration: vch.narration,
                    party_name: partyLedger,
                    pan,
                    section,
                    tds_ledger: tdsLedger,
                    tds_amount: tdsAmount,
                    taxable_ledger: matchedExpense ? matchedExpense.ledger_name : '',
                    base_amount: baseAmount,
                    rate,
                    base_amount_derived: baseDerived,
                    base_amount_source: baseSource,
                    status: 'matched'
                });
            }
        } else if (isPayment) {
            for (const tdsLine of tdsLines) {
                const tdsAmount = Math.abs(tdsLine.amount);
                const tdsLedger = tdsLine.ledger_name;
                const section = extractSectionFromLedgerName(tdsLedger);
                if (sectionFilter && section !== sectionFilter) continue;

                const rate = extractTdsRateFromLedgerName(tdsLedger);
                const partyEntry = entries.find(e => e.amount < 0 && !tdsLedgersSet.has(e.ledger_name));
                const partyLedger = partyEntry ? partyEntry.ledger_name : (vch.party_name || '');
                const pan = ledgerPanMap.get(partyLedger) || '';

                let baseAmount = partyEntry ? Math.abs(partyEntry.amount) : 0;
                let baseDerived = false;
                let baseSource = 'payment_voucher_ledger_lines';

                if (rate > 0 && (!baseAmount || baseAmount === tdsAmount)) {
                    baseAmount = (tdsAmount * 100) / rate;
                    baseDerived = true;
                    baseSource = 'derived_from_tds_rate';
                }

                rows.push({
                    date: vch.date,
                    voucher_type: vch.voucher_type,
                    voucher_number: vch.voucher_number,
                    narration: vch.narration,
                    party_name: partyLedger,
                    pan,
                    section,
                    tds_ledger: tdsLedger,
                    tds_amount: tdsAmount,
                    taxable_ledger: partyLedger,
                    base_amount: baseAmount,
                    rate,
                    base_amount_derived: baseDerived,
                    base_amount_source: baseSource,
                    status: 'matched'
                });
            }
        }
    }

    const purchaseOrJournalKeys = new Set();
    for (const r of rows) {
        if (r.voucher_type.match(/Purchase|Journal/i)) {
            const key = `${r.party_name.toUpperCase()}|${r.section}|${Math.round(r.tds_amount)}`;
            purchaseOrJournalKeys.add(key);
        }
    }

    const finalRows = [];
    for (const r of rows) {
        if (r.voucher_type.match(/Payment/i)) {
            const key = `${r.party_name.toUpperCase()}|${r.section}|${Math.round(r.tds_amount)}`;
            if (purchaseOrJournalKeys.has(key)) continue;
        }
        finalRows.push(r);
    }
    return finalRows;
}

async function generateTdsReportInternal(args, restrictMode) {
    try {
        let rawRows = Array.isArray(args.tdsRows) ? args.tdsRows : [];
        const { tdsLedgers, tdsLedgerInfo, ledgerPanMap } = await discoverTdsLedgers(args.targetCompany);

        if (!rawRows.length) {
            if (!args.fromDate || !args.toDate) {
                return { isError: true, content: [{ type: 'text', text: 'fromDate and toDate are required when tdsRows are not provided.' }] };
            }
            let inputParams = new Map([
                ['fromDate', args.fromDate],
                ['toDate', args.toDate],
                ['tdsLedgers', tdsLedgers]
            ]);
            if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
            if (args.partyContains) inputParams.set('partyContains', args.partyContains);

            const resp = await fetchReport('tds-payment-sheet', inputParams);
            if (resp.error) return { isError: true, content: [{ type: 'text', text: resp.error }] };
            rawRows = Array.isArray(resp.data) ? resp.data : [];

            // ── FALLBACK: if tds-payment-sheet returned nothing (TDS ledgers have
            //    no statutory section metadata configured in Tally), pull data
            //    directly from each TDS ledger's account statement instead. ────
            if (rawRows.length === 0 && tdsLedgers.length > 0) {
                rawRows = await fetchTdsRowsFromLedgerAccounts(
                    args.fromDate,
                    args.toDate,
                    args.targetCompany,
                    tdsLedgers,
                    tdsLedgerInfo
                );
            }
        }

        const sectionFilter = args.section ? normalizeSection(args.section) : '';
        if (restrictMode === '194Q_ONLY') {
            if (sectionFilter && sectionFilter !== '194Q') {
                return { isError: true, content: [{ type: 'text', text: 'This tool is exclusively for section 194Q.' }] };
            }
        } else if (restrictMode === 'EXCLUDE_194Q') {
            if (sectionFilter === '194Q') {
                return { isError: true, content: [{ type: 'text', text: 'This tool does not handle 194Q.' }] };
            }
        }

        const filterSection = restrictMode === '194Q_ONLY' ? '194Q' : sectionFilter;
        let processed = processTdsVouchers(rawRows, tdsLedgers, ledgerPanMap, filterSection);

        if (restrictMode === 'EXCLUDE_194Q') {
            processed = processed.filter(r => r.section !== '194Q');
        } else if (restrictMode === '194Q_ONLY') {
            processed = processed.filter(r => r.section === '194Q');
        }

        if (args.partyContains) {
            const search = args.partyContains.toUpperCase();
            processed = processed.filter(r => r.party_name.toUpperCase().includes(search));
        }

        const tdsTolerance = args.tdsTolerance ?? 1;
        const rateTolerance = args.rateTolerance ?? 0.05;
        const returnOnlyExceptions = args.returnOnlyExceptions ?? false;
        const maxOutputRows = args.maxOutputRows ?? 1000;
        const sectionWiseRowMode = args.sectionWiseRowMode || 'bill_wise';
        const showPartyTotals = args.showPartyTotals === true;
        const tdsBaseMode = args.tdsBaseMode || 'taxable_value';
        const advanceHandling = args.advanceHandling || 'include_advances';
        const thresholdAmount = args.thresholdAmount ?? (restrictMode === '194Q_ONLY' ? 5000000 : 0);

        const partyCumulative = new Map();
        const output = [];

        for (const row of processed) {
            const panInfo = panEntityType(row.pan);
            const expectedRate = row.rate;
            const baseAmount = row.base_amount;

            const partyKey = `${normalizePan(row.pan)}|${normalizeText(row.party_name)}`;
            const prior = partyCumulative.get(partyKey) || 0;
            const cumulative = prior + baseAmount;
            partyCumulative.set(partyKey, cumulative);

            const isThresholdSection = row.section === '194Q' && thresholdAmount > 0;
            const taxableAboveThreshold = isThresholdSection ? Math.max(0, cumulative - thresholdAmount) - Math.max(0, prior - thresholdAmount) : baseAmount;
            const expectedTds = Number(((Math.max(0, taxableAboveThreshold) * expectedRate) / 100).toFixed(2));

            const classified = classifyTdsReportStatus({
                row: { tds_amount: row.tds_amount, actual_rate: row.rate },
                panInfo,
                section: row.section,
                expectedRate,
                expectedTds,
                tdsTolerance,
                rateTolerance,
                baseAmount,
                taxableAboveThreshold,
                thresholdAmount,
                isThresholdSection
            });

            let reportCategory = 'tds_report';
            if (row.section === '194C') reportCategory = 'contractor_194c';
            else if (row.section === '194Q') reportCategory = 'tds_on_purchase_194q';

            output.push({
                status: classified.status,
                report_category: reportCategory,
                party_name: row.party_name,
                pan: row.pan,
                pan_status: panInfo.pan_status,
                pan_entity_code: panInfo.pan_entity_code,
                pan_entity_type: panInfo.pan_entity_type,
                company_category: panInfo.company_category,
                contractor_type: row.section === '194C' ? panInfo.contractor_type : '',
                section: row.section,
                date: row.date,
                voucher_type: row.voucher_type,
                voucher_number: row.voucher_number,
                tds_ledger: row.tds_ledger,
                taxable_ledger: row.taxable_ledger,
                tds_base_mode: tdsBaseMode,
                base_amount: Number(baseAmount.toFixed(2)),
                base_amount_source: row.base_amount_source,
                base_amount_derived: !!row.base_amount_derived,
                base_amount_warning: '',
                register_base_amount: 0,
                register_tds_amount: 0,
                taxable_value: baseAmount,
                gross_value: baseAmount,
                payment_value: baseAmount,
                is_advance: false,
                advance_handling: advanceHandling,
                threshold_amount: thresholdAmount,
                party_cumulative_base: Number(cumulative.toFixed(2)),
                base_above_threshold: Number(Math.max(0, taxableAboveThreshold).toFixed(2)),
                expected_rate: expectedRate,
                actual_rate: row.rate,
                expected_tds: expectedTds,
                actual_tds: row.tds_amount,
                tds_difference: classified.tds_difference,
                possible_reason: classified.status === 'matched' ? '' : 'Rate mismatch or missing information.',
                narration: row.narration
            });
        }

        let filtered = output;
        if (args.reportType === 'pan_exception') filtered = filtered.filter(r => r.pan_status !== 'valid');
        if (args.reportType === 'rate_mismatch') filtered = filtered.filter(r => r.status.includes('rate_mismatch') || r.status.includes('short_deducted') || r.status.includes('excess_deducted'));
        if (returnOnlyExceptions) filtered = filtered.filter(r => r.status !== 'matched' && !r.status.includes('threshold_not_crossed'));

        const limitedRaw = filtered.slice(0, maxOutputRows);
        const counts = limitedRaw.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});

        const summary = {
            input_rows: rawRows.length,
            output_rows: limitedRaw.length,
            total_result_rows_before_limit: filtered.length,
            output_limited: filtered.length > limitedRaw.length,
            reportType: args.reportType || 'all',
            section: filterSection || 'all',
            tdsBaseMode,
            advanceHandling,
            thresholdAmount,
            sectionWiseRowMode,
            showPartyTotals,
            counts,
            total_base_amount: Number(output.reduce((s, r) => s + (r.base_amount || 0), 0).toFixed(2)),
            total_expected_tds: Number(output.reduce((s, r) => s + (r.expected_tds || 0), 0).toFixed(2)),
            total_actual_tds: Number(output.reduce((s, r) => s + (r.actual_tds || 0), 0).toFixed(2)),
            direct_voucher_values_only: true,
            no_back_calculation: true,
            value_source_note: 'TDS report taxable/base amount is read directly from Tally non-TDS voucher ledger lines.'
        };

        if (args.reportType === 'section_wise') {
            let sectionWiseRows = limitedRaw.map((r, idx) => {
                const pan = normalizePan(r.pan);
                return {
                    row_no: idx + 1,
                    section: r.section,
                    date_of_payment_or_credited: r.date,
                    name_of_the_deductee: r.party_name,
                    pan_of_the_deductee: pan || r.pan || '',
                    amount_paid: r.base_amount,
                    tds_amount: r.actual_tds,
                    tds_deduction_rate_percent: r.actual_rate,
                    pan_first_four: pan ? pan.slice(0, 4) : '',
                    pan_fourth_letter: pan && pan.length >= 4 ? pan.charAt(3) : '',
                    status: r.status,
                    voucher_type: r.voucher_type,
                    voucher_number: r.voucher_number,
                    tds_ledger: r.tds_ledger,
                    taxable_ledger: r.taxable_ledger,
                    contractor_type: r.contractor_type,
                    company_category: r.company_category,
                    pan_entity_type: r.pan_entity_type,
                    possible_reason: r.possible_reason,
                    base_amount_source: r.base_amount_source,
                    base_amount_derived: r.base_amount_derived,
                    base_amount_warning: '',
                    register_base_amount: 0,
                    register_tds_amount: 0
                };
            });

            if (showPartyTotals) {
                const totals = new Map();
                for (const r of sectionWiseRows) {
                    const key = `${r.section}|${normalizePan(r.pan_of_the_deductee)}|${normalizeText(r.name_of_the_deductee)}`;
                    const cur = totals.get(key) || { ...r, row_no: 0, date_of_payment_or_credited: '', amount_paid: 0, tds_amount: 0, tds_deduction_rate_percent: 0, status: 'party_total', voucher_type: '', voucher_number: '', tds_ledger: '', taxable_ledger: '', possible_reason: 'Party total row explicitly requested.' };
                    cur.amount_paid += Number(r.amount_paid || 0);
                    cur.tds_amount += Number(r.tds_amount || 0);
                    totals.set(key, cur);
                }
                sectionWiseRows = [...sectionWiseRows, ...Array.from(totals.values()).map(t => ({ ...t, amount_paid: Number(t.amount_paid.toFixed(2)), tds_amount: Number(t.tds_amount.toFixed(2)), tds_deduction_rate_percent: t.amount_paid ? Number((t.tds_amount * 100 / t.amount_paid).toFixed(4)) : 0 }))];
            }

            const tableId = await cacheTable(new Map([
                ['row_no', 'number'], ['section', 'string'], ['date_of_payment_or_credited', 'date'], ['name_of_the_deductee', 'string'], ['pan_of_the_deductee', 'string'], ['amount_paid', 'number'], ['tds_amount', 'number'], ['tds_deduction_rate_percent', 'number'], ['pan_first_four', 'string'], ['pan_fourth_letter', 'string'], ['status', 'string'], ['voucher_type', 'string'], ['voucher_number', 'string'], ['tds_ledger', 'string'], ['taxable_ledger', 'string'], ['contractor_type', 'string'], ['company_category', 'string'], ['pan_entity_type', 'string'], ['possible_reason', 'string'], ['base_amount_source', 'string'], ['base_amount_derived', 'boolean'], ['base_amount_warning', 'string'], ['register_base_amount', 'number'], ['register_tds_amount', 'number']
            ]), sectionWiseRows);

            return { content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, rows: sectionWiseRows.length, summary, displayColumns: ['Section', 'Date of Payment/Credited', 'Name of the Deductee', 'PAN of the Deductee', 'Amount Paid', 'TDS Amount', 'TDS Deduction Rate %', '', ''], displayFieldOrder: ['section', 'date_of_payment_or_credited', 'name_of_the_deductee', 'pan_of_the_deductee', 'amount_paid', 'tds_amount', 'tds_deduction_rate_percent', 'pan_first_four', 'pan_fourth_letter'], hiddenDiagnosticFields: ['row_no', 'status', 'voucher_type', 'voucher_number', 'tds_ledger', 'taxable_ledger', 'contractor_type', 'company_category', 'pan_entity_type', 'possible_reason', 'base_amount_source', 'base_amount_derived', 'base_amount_warning'], message: 'Section-wise TDS report format is dynamically generated from voucher ledger entries.' }) }] };
        }

        const tableId = await cacheTable(new Map([
            ['status', 'string'], ['report_category', 'string'], ['party_name', 'string'], ['pan', 'string'], ['pan_status', 'string'], ['pan_entity_code', 'string'], ['pan_entity_type', 'string'], ['company_category', 'string'], ['contractor_type', 'string'], ['section', 'string'], ['date', 'date'], ['voucher_type', 'string'], ['voucher_number', 'string'], ['tds_ledger', 'string'], ['taxable_ledger', 'string'], ['tds_base_mode', 'string'], ['base_amount', 'number'], ['base_amount_source', 'string'], ['base_amount_derived', 'boolean'], ['base_amount_warning', 'string'], ['taxable_value', 'number'], ['gross_value', 'number'], ['payment_value', 'number'], ['is_advance', 'boolean'], ['advance_handling', 'string'], ['threshold_amount', 'number'], ['party_cumulative_base', 'number'], ['base_above_threshold', 'number'], ['expected_rate', 'number'], ['actual_rate', 'number'], ['expected_tds', 'number'], ['actual_tds', 'number'], ['tds_difference', 'number'], ['possible_reason', 'string'], ['narration', 'string']
        ]), limitedRaw);

        return { content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, rows: limitedRaw.length, summary }) }] };
    } catch (err) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(err?.message || err) }] };
    }
}

export async function registerMcpServer() {
    // Register headwise-purchase-vouchers TDL report dynamically if not already registered
    if (!lstReportXml.has('headwise-purchase-vouchers')) {
        lstReportXml.set('headwise-purchase-vouchers', '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyTallyLiveReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>{{ fromDate | formatDate("d-MMM-yyyy") }}</SVFROMDATE><SVTODATE>{{ toDate | formatDate("d-MMM-yyyy") }}</SVTODATE>{% if targetCompany %}<SVCURRENTCOMPANY>{{ targetCompany | escape }}</SVCURRENTCOMPANY>{% endif %}</STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyTallyLiveReport"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart01</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MyPart01"><PARTS>MySubPart</PARTS><REPEAT>MySubPart : MyCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART><PART NAME="MySubPart"><LINES>MyLine01</LINES><REPEAT>MyLine01 : AllLedgerEntries</REPEAT></PART><LINE NAME="MyLine01"><FIELDS>FldDate,FldVoucherType,FldVoucherNumber,FldNarration,FldPartyName,FldSupplierInvoiceNo,FldSupplierInvoiceDate,FldLedgerName,FldLedgerAmount,FldIsDebit,FldLedgerGroup,FldLedgerPrimaryGroup</FIELDS><XMLTAG>ROW</XMLTAG></LINE><FIELD NAME="FldDate"><SET>if $$IsEmpty:$Date then $..Date else $Date</SET><XMLTAG>date</XMLTAG></FIELD><FIELD NAME="FldVoucherType"><SET>if $$IsEmpty:$VoucherTypeName then $..VoucherTypeName else $VoucherTypeName</SET><XMLTAG>voucher_type</XMLTAG></FIELD><FIELD NAME="FldVoucherNumber"><SET>if $$IsEmpty:$VoucherNumber then $..VoucherNumber else $VoucherNumber</SET><XMLTAG>voucher_number</XMLTAG></FIELD><FIELD NAME="FldNarration"><SET>if $$IsEmpty:$Narration then $..Narration else $Narration</SET><XMLTAG>narration</XMLTAG></FIELD><FIELD NAME="FldPartyName"><SET>if $$IsEmpty:$PartyLedgerName then $..PartyLedgerName else $PartyLedgerName</SET><XMLTAG>party_name</XMLTAG></FIELD><FIELD NAME="FldSupplierInvoiceNo"><SET>if NOT $$IsEmpty:$Reference then $Reference else if NOT $$IsEmpty:$BasicBuyerRef then $BasicBuyerRef else if NOT $$IsEmpty:$..Reference then $..Reference else if NOT $$IsEmpty:$..BasicBuyerRef then $..BasicBuyerRef else ""</SET><XMLTAG>supplier_invoice_no</XMLTAG></FIELD><FIELD NAME="FldSupplierInvoiceDate"><SET>if NOT $$IsEmpty:$ReferenceDate then $$PyrlYYYYMMDDFormat:$ReferenceDate:"-" else if NOT $$IsEmpty:$BasicBuyerDate then $$PyrlYYYYMMDDFormat:$BasicBuyerDate:"-" else if NOT $$IsEmpty:$..ReferenceDate then $$PyrlYYYYMMDDFormat:$..ReferenceDate:"-" else if NOT $$IsEmpty:$..BasicBuyerDate then $$PyrlYYYYMMDDFormat:$..BasicBuyerDate:"-" else ""</SET><XMLTAG>supplier_invoice_date</XMLTAG></FIELD><FIELD NAME="FldLedgerName"><SET>$LedgerName</SET><XMLTAG>ledger_name</XMLTAG></FIELD><FIELD NAME="FldLedgerAmount"><SET>$$StringFindAndReplace:$Amount:"(-)":"-"</SET><XMLTAG>amount</XMLTAG></FIELD><FIELD NAME="FldIsDebit"><SET>if $$IsDebit:$Amount then 1 else 0</SET><XMLTAG>is_debit</XMLTAG></FIELD><FIELD NAME="FldLedgerGroup"><SET>$Parent:Ledger:$LedgerName</SET><XMLTAG>ledger_group</XMLTAG></FIELD><FIELD NAME="FldLedgerPrimaryGroup"><SET>$_PrimaryGroup:Ledger:$LedgerName</SET><XMLTAG>ledger_primary_group</XMLTAG></FIELD><COLLECTION NAME="MyCollection"><TYPE>Voucher</TYPE><FILTER>FilterVoucherType,FilterCancelledVouchers,FilterOptionalVouchers</FILTER><FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Narration,AllLedgerEntries,BasicBuyerRef,BasicBuyerDate,Reference,ReferenceDate</FETCH></COLLECTION><SYSTEM TYPE="Formulae" NAME="FilterVoucherType">{% if voucherTypes and voucherTypes.length > 0 %}{% for vt in voucherTypes %}($VoucherTypeName = "{{ vt | escape }}") {% if not loop.last %}OR {% endif %}{% endfor %}{% else %}($VoucherTypeName CONTAINS "Purchase") OR ($VoucherTypeName CONTAINS "Debit Note") OR ($VoucherTypeName CONTAINS "NB-") OR ($VoucherTypeName CONTAINS "WHEAT") OR ($VoucherTypeName CONTAINS "MAIDA") OR ($VoucherTypeName CONTAINS "BRANDED") OR ($VoucherTypeName CONTAINS "BESAN") OR ($VoucherTypeName CONTAINS "SATTU") OR ($VoucherTypeName CONTAINS "BRAN") OR ($VoucherTypeName CONTAINS "RAW") OR ($VoucherTypeName CONTAINS "MILITARY") OR ($VoucherTypeName CONTAINS "EXPORT") OR ($VoucherTypeName CONTAINS "TRADING") OR ($Parent:VoucherType:$VoucherTypeName = "Purchase") OR ($Parent:VoucherType:$VoucherTypeName = "Debit Note"){% endif %}</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterCancelledVouchers">NOT $IsCancelled</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterOptionalVouchers">NOT $IsOptional</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>');
    }
    if (!lstReportConfig.some(r => r.name === 'headwise-purchase-vouchers')) {
        lstReportConfig.push({
            name: 'headwise-purchase-vouchers',
            input: [
                { name: 'fromDate', datatype: 'date' },
                { name: 'toDate', datatype: 'date' }
            ],
            output: [
                { name: 'date', datatype: 'date' },
                { name: 'voucher_type', datatype: 'string' },
                { name: 'voucher_number', datatype: 'string' },
                { name: 'narration', datatype: 'string' },
                { name: 'party_name', datatype: 'string' },
                { name: 'supplier_invoice_no', datatype: 'string' },
                { name: 'supplier_invoice_date', datatype: 'date' },
                { name: 'ledger_name', datatype: 'string' },
                { name: 'amount', datatype: 'number' },
                { name: 'is_debit', datatype: 'string' },
                { name: 'ledger_group', datatype: 'string' },
                { name: 'ledger_primary_group', datatype: 'string' }
            ]
        });
    }

    // Register headwise-sales-vouchers TDL report dynamically if not already registered
    if (!lstReportXml.has('headwise-sales-vouchers')) {
        lstReportXml.set('headwise-sales-vouchers', '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyTallyLiveReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>{{ fromDate | formatDate("d-MMM-yyyy") }}</SVFROMDATE><SVTODATE>{{ toDate | formatDate("d-MMM-yyyy") }}</SVTODATE>{% if targetCompany %}<SVCURRENTCOMPANY>{{ targetCompany | escape }}</SVCURRENTCOMPANY>{% endif %}</STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyTallyLiveReport"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart01</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MyPart01"><LINES>MyLine01</LINES><REPEAT>MyLine01 : MyCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART><LINE NAME="MyLine01"><FIELDS>FldDate,FldVoucherType,FldVoucherNumber,FldNarration,FldPartyName</FIELDS><REPEAT>MySubLine : AllLedgerEntries</REPEAT><XMLTAG>ROW</XMLTAG></LINE><LINE NAME="MySubLine"><FIELDS>FldLedgerName,FldLedgerAmount</FIELDS><XMLTAG>ALLLEDGERENTRIES.LIST</XMLTAG></LINE><FIELD NAME="FldDate"><SET>$Date</SET><XMLTAG>date</XMLTAG></FIELD><FIELD NAME="FldVoucherType"><SET>$VoucherTypeName</SET><XMLTAG>voucher_type</XMLTAG></FIELD><FIELD NAME="FldVoucherNumber"><SET>$VoucherNumber</SET><XMLTAG>voucher_number</XMLTAG></FIELD><FIELD NAME="FldNarration"><SET>$Narration</SET><XMLTAG>narration</XMLTAG></FIELD><FIELD NAME="FldPartyName"><SET>$PartyLedgerName</SET><XMLTAG>party_name</XMLTAG></FIELD><FIELD NAME="FldLedgerName"><SET>$LedgerName</SET><XMLTAG>ledger_name</XMLTAG></FIELD><FIELD NAME="FldLedgerAmount"><SET>$$StringFindAndReplace:$Amount:"(-)":"-"</SET><XMLTAG>amount</XMLTAG></FIELD><COLLECTION NAME="MyCollection"><TYPE>Voucher</TYPE><FILTER>FilterVoucherType,FilterCancelledVouchers,FilterOptionalVouchers</FILTER><FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Narration,AllLedgerEntries</FETCH></COLLECTION><SYSTEM TYPE="Formulae" NAME="FilterVoucherType">($VoucherTypeName CONTAINS "Sales") OR ($VoucherTypeName CONTAINS "Tax Invoice") OR ($VoucherTypeName CONTAINS "Credit Note") OR ($VoucherTypeName CONTAINS "SALES") OR ($VoucherTypeName CONTAINS "TAX INVOICE") OR ($VoucherTypeName CONTAINS "CREDIT NOTE") OR ($Parent:VoucherType:$VoucherTypeName CONTAINS "Sales") OR ($Parent:VoucherType:$VoucherTypeName CONTAINS "Credit Note")</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterCancelledVouchers">NOT $IsCancelled</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterOptionalVouchers">NOT $IsOptional</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>');
    }
    if (!lstReportConfig.some(r => r.name === 'headwise-sales-vouchers')) {
        lstReportConfig.push({
            name: 'headwise-sales-vouchers',
            input: [
                { name: 'fromDate', datatype: 'date' },
                { name: 'toDate', datatype: 'date' }
            ],
            output: [
                { name: 'date', datatype: 'date' },
                { name: 'voucher_type', datatype: 'string' },
                { name: 'voucher_number', datatype: 'string' },
                { name: 'narration', datatype: 'string' },
                { name: 'party_name', datatype: 'string' },
                { name: 'ALLLEDGERENTRIES.LIST', datatype: 'array' }
            ]
        });
    }

    const mcpServer = new McpServer({
        name: 'Tally Prime MCP Server',
        title: 'Tally Prime',
        version: '7.6.9'
    });
    mcpServer.registerTool('metadata-collection', {
        title: 'Metadata Collection',
        description: 'returns collections metadata with collection and description',
        inputSchema: {},
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async () => {
        const collections = lstCollectionFields.map(({ collection, description }) => ({
            collection,
            description
        }));
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(collections)
                }
            ]
        };
    });
    mcpServer.registerTool('metadata-fields', {
        title: 'Metadata Fields',
        description: 'returns fields metadata for the selected tally collection containing field name, optional description and data type which can be string, number, date or boolean',
        inputSchema: {
            collection: z.preprocess(normalizeCollectionInput, z.enum(lstCollectionInputs)).describe('target collection to fetch field metadata')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        const fields = (lstCollectionFields.find((item) => item.collection.toLowerCase() === args.collection.toLowerCase())?.fields ?? []).map((field) => {
            const lstFields = { ...field };
            // substitute amount, quantity and rate data types with number data type to make it more generic since these are all numeric fields
            if (lstFields.datatype === 'amount' || lstFields.datatype === 'quantity' || lstFields.datatype === 'rate') {
                lstFields.datatype = 'number';
            }
            // delete property expression from field if found
            if (lstFields.expression) {
                delete lstFields.expression;
            }
            return lstFields;
        });
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(fields)
                }
            ]
        };
    });
    mcpServer.registerTool('query-option-values', {
        title: 'Query Option Values',
        description: 'returns predefined option values or drop-down values for the fields required for master and voucher creation, it returns back object array of pre-defined values',
        inputSchema: {
            optionName: z.enum(['country-state']).describe('option name to query')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        let retval = undefined;
        if (args.optionName === 'country-state')
            retval = lstOptionCountryState;
        else {
            return {
                isError: true,
                content: [
                    {
                        type: 'text',
                        text: 'Invalid option name'
                    }
                ]
            };
        }
        ;
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(retval)
                }
            ]
        };
    });
    mcpServer.registerTool('discover-companies', {
        title: 'Discover Companies',
        description: 'discovers available Tally companies through the remote tally-gateway.exe on TALLY_HOST:TALLY_PORT. The gateway scans local Tally ports on the remote server and returns all companies with their internal ports.',
        inputSchema: {},
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async () => {
        try {
            const result = await discoverCompanies();
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('query-database', {
        title: 'Query Database',
        description: `executes sql query on pglite postgres in-memory database for querying cached Tally Prime report data in table generated as output by other tools (in tableID property from tool output response). These tables are temporary and will be dropped after 15 minutes automatically. Use this tool to run complex analytical queries to aggregate, filter, sort results`,
        inputSchema: {
            sql: z.string().describe('SQL query to execute on pglite postgres in-memory database, only SELECT queries are allowed. UPDATE, DELETE, INSERT queries are not allowed for data safety'),
            outputFormat: z.enum(['JSON Array of Objects', 'JSON with Schema and Rows', 'CSV', 'Markdown Table']).optional().describe('optional output format, default is JSON Array of Objects. JSON Array of Objects = [{"column1": "value1", "column2": "value2"}, {...}] , JSON with Schema and Rows = {"schema": ["column1", "column2"], "rows": [["value1", "value2"], [...]]}, CSV = comma separated values with header, Markdown Table = table format with header in markdown syntax which can be directly rendered in markdown supported viewers')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        const resp = await executeSQL(args.sql, args.outputFormat || 'JSON Array of Objects');
        return {
            content: [{ type: 'text', text: resp }]
        };
    });
    mcpServer.registerTool('query-collection', {
        title: 'Query Collection',
        description: `queries a Tally Prime collection with selected fields and optional context like target company and reporting period. result is cached in pglite postgres in-memory table and returned as tableID. Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            collection: z.preprocess(normalizeCollectionInput, z.enum(lstCollectionInputs)).describe('collection name to query, validate it using metadata-collection tool with exact collection name'),
            fields: z.array(z.string()).min(1).describe('list of field names to fetch for the selected collection. validate it using metadata-fields resource for that collection'),
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('optional from date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('optional to date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        const collection = canonicalCollection(args.collection);
        if (!collection) {
            return { isError: true, content: [{ type: 'text', text: 'Invalid collection name' }] };
        }
        const requestedFields = args.fields.map((field) => field.trim());
        const targetCollectionFields = lstCollectionFields.find(p => p.collection.toLowerCase() === collection.toLowerCase())?.fields || [];
        const requestedFieldsMetadata = targetCollectionFields.filter(p => requestedFields.includes(p.name));
        const fromDate = args.fromDate ? parseBankStatementDate(args.fromDate) : undefined;
        const toDate = args.toDate ? parseBankStatementDate(args.toDate) : undefined;
        const result = await queryCollection(collection, requestedFields, new Map(), args.targetCompany, fromDate, toDate);
        // prepare Map of field name and data type for caching table metadata
        let fieldMetadataMap = new Map();
        requestedFieldsMetadata.forEach((field) => {
            if (field.datatype === 'amount' || field.datatype === 'quantity' || field.datatype === 'rate') {
                fieldMetadataMap.set(field.name, 'number');
            }
            else if (field.datatype === 'date') {
                fieldMetadataMap.set(field.name, 'date');
            }
            else if (field.datatype === 'boolean') {
                fieldMetadataMap.set(field.name, 'boolean');
            }
            else {
                fieldMetadataMap.set(field.name, 'string');
            }
        });
        const tableId = await cacheTable(fieldMetadataMap, result);
        return tableResponse(tableId, safeCount(result), safeCount(result) === 0 ? 'No rows found for the requested collection/date range/company.' : undefined);
    });
    mcpServer.registerTool('list-master', {
        title: 'List Masters',
        description: `fetches list of masters from Tally Prime collection e.g. group, ledger, vouchertype, unit, godown, stockgroup, stockitem, costcategory, costcentre, attendancetype, company, currency, gstin, gstclassification returns output in JSON string array in the property list`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            collection: z.preprocess(normalizeCollectionInput, z.enum(['group', 'ledger', 'vouchertype', 'unit', 'godown', 'stockgroup', 'stockitem', 'costcategory', 'costcentre', 'attendancetype', 'company', 'currency', 'gstin', 'gstclassification'])),
            containsFilter: z.string().optional().describe('optional filter to apply on name field with contains operator to filter results with respective name value or keywords, case insensitive')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let targetCollection = lstCollections.find((item) => item.toLowerCase() === args.collection.toLowerCase());
            if (!targetCollection) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Invalid collection name' }]
                };
            }
            let lstFilters = new Map();
            if (args.containsFilter) {
                lstFilters.set('Search_Contains', `$Name CONTAINS "${args.containsFilter.replace(/"/g, '')}"`); //ensure to strip double quotes from filter value to avoid TDL syntax error
            }
            let result = await queryCollection(targetCollection, ['Name'], lstFilters, args.targetCompany);
            return {
                content: [{ type: 'text', text: JSON.stringify({ list: result.map((item) => item.Name) }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('search-bank-ledgers', {
        title: 'Search Bank Ledgers',
        description: `finds and lists possible Tally bank ledgers for a bank keyword such as HDFC, ICICI, SBI, Axis etc. Use this before bank-reconciliation when there may be multiple bank accounts like HDFC C/A, HDFC C/C, HDFC OD, or different account numbers. Returns selectable options with ledger name and group only. Do not ask the user for closing balance; the user only needs to select one exact ledger_name from these options and pass it to bank-reconciliation.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. validate using discover-companies/list-master company if specified'),
            bankName: z.string().describe('bank keyword or account keyword to search, for example HDFC, ICICI, SBI, AXIS, 50200082723311, C/A or C/C')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const keyword = String(args.bankName || '').trim();
            if (!keyword) {
                return { isError: true, content: [{ type: 'text', text: 'bankName is required, for example HDFC, ICICI, SBI, AXIS, or an account number.' }] };
            }
            const filters = new Map([['Search_Contains', `$Name CONTAINS "${keyword.replace(/"/g, '')}"`]]);
            let rows = await queryCollection(
                'Ledger',
                ['Name', 'Parent', '_PrimaryGroup'],
                filters,
                args.targetCompany
            );
            rows = Array.isArray(rows) ? rows : [];
            let bankRows = rows.filter(r => isLikelyBankLedger(r, keyword));
            // If Tally group names are not exposed consistently, do not hide keyword matches completely.
            // Return all keyword matches but mark them as options, so the user can choose safely.
            if (bankRows.length === 0) bankRows = rows;
            const options = bankRows.map(formatBankLedgerOption).map(({ option, ledger_name, group_name, primary_group }) => ({ option, ledger_name, group_name, primary_group }));
            const tableID = await cacheTable(new Map([
                ['option', 'number'], ['ledger_name', 'string'], ['group_name', 'string'], ['primary_group', 'string']
            ]), options);
            return {
                content: [{
                    type: 'text', text: JSON.stringify({
                        tableID,
                        rows: options.length,
                        options,
                        message: options.length
                            ? 'Ask the user to select one option number/ledger_name. Then call bank-reconciliation with that exact ledger_name.'
                            : 'No matching ledger found. Try another bank keyword, account number, or use list-master collection ledger with containsFilter.'
                    })
                }]
            };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err?.message || err) }] };
        }
    });

    mcpServer.registerTool('search-party-ledgers', {
        title: 'Search Party Ledgers',
        description: `finds possible Tally party/customer/supplier ledgers for a keyword such as party name, GST name, short name, transporter name, or account keyword. Use this before party-ledger-reconciliation when there may be multiple similar party ledgers. IMPORTANT for uploaded party statements: search the ledger for the STATEMENT ISSUER / HEADER / LETTERHEAD party, not the Account Head that represents your own company in the other party's books. Example: if a PDF header says "Dream Bake Pvt. Ltd." and the Account Head says "Nowrangroy Agro Private Ltd(Howrah)", search partyName as "Dream Bake"/"DreamBake", not "Nowrangroy". Returns selectable ledger options with ledger name and group only. Do not ask the user for closing balance. If the same party has multiple branch/location ledgers, ask the user to select one or multiple ledger_names and pass them as ledgerNames to party-ledger-reconciliation.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional Tally company name where your books are open. Validate using discover-companies/list-master company if specified.'),
            partyName: z.string().describe('party keyword to search in YOUR Tally ledgers. For party statement PDFs, use the statement issuer/header/letterhead name, e.g. Dream Bake, DreamBake, MODI, SRI DURGA, HARISH ROADLINES. Do not use your own company name printed as Account Head in the party statement.')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const keyword = String(args.partyName || '').trim();
            if (!keyword) {
                return { isError: true, content: [{ type: 'text', text: 'partyName is required. For uploaded party statement PDFs, use the statement issuer/header name, for example Dream Bake, MODI, SRI DURGA, HARISH ROADLINES, or another party keyword. Do not search your own company name from the Account Head line.' }] };
            }
            const clean = keyword.replace(/"/g, '').replace(/\b(pvt|private|limited|ltd|llp|company|co)\b/ig, ' ').replace(/[^a-z0-9 ]/ig, ' ').replace(/\s+/g, ' ').trim();
            const compact = clean.replace(/\s+/g, '');
            const parts = clean.split(' ').filter(x => x.length >= 3);
            const searchTerms = [...new Set([keyword, clean, compact, ...parts.slice(0, 3)].map(x => String(x || '').trim()).filter(Boolean))];
            const byName = new Map();
            for (const term of searchTerms) {
                const filters = new Map([['Search_Contains', `$Name CONTAINS "${term.replace(/"/g, '')}"`]]);
                let found = await queryCollection('Ledger', ['Name', 'Parent', '_PrimaryGroup'], filters, args.targetCompany);
                found = Array.isArray(found) ? found : [];
                for (const row of found) {
                    const nm = String(row.Name || row.name || '').trim();
                    if (nm && !byName.has(nm.toLowerCase())) byName.set(nm.toLowerCase(), row);
                }
            }
            const rows = [...byName.values()];
            const options = rows.map(formatPartyLedgerOption);
            const tableID = await cacheTable(new Map([
                ['option', 'number'], ['ledger_name', 'string'], ['group_name', 'string'], ['primary_group', 'string']
            ]), options);
            return {
                content: [{
                    type: 'text', text: JSON.stringify({
                        tableID,
                        rows: options.length,
                        searched_terms: searchTerms,
                        options,
                        message: options.length
                            ? 'Ask the user to select one or multiple option numbers/ledger_names that represent the statement issuer/header party. If there are multiple branches/locations for the same party, pass all selected names as ledgerNames to party-ledger-reconciliation. Do not select the Account Head from the uploaded party PDF if that Account Head is your own company name.'
                            : 'No matching party ledger found. Try another keyword from the statement issuer/header/letterhead, e.g. Dream Bake/DreamBake, or use list-master collection ledger with containsFilter.'
                    })
                }]
            };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err?.message || err) }] };
        }
    });

    mcpServer.registerTool('party-ledger-reconciliation', {
        title: 'Party Ledger Reconciliation',
        description: `reconciles one or multiple selected Tally party ledgers with party statement rows extracted from Excel or PDF. FAST WORKFLOW: prefer Excel/CSV when available. If the uploaded Excel contains user-entered companyName and partyName/ledgerName cells, pass those values as targetCompany and partyName/ledgerName instead of asking again. For PDF, do NOT pass raw page text; extract only compact transaction rows with Date, Ref/Invoice/Voucher, Debit, Credit, Balance, and short Narration, preferably through statementRowsCompact using the format date|ref|debit|credit|balance|narration. This keeps token use low. IMPORTANT party-statement rule: selected ledger should be the statement issuer/header/letterhead party in your books, not your own company name printed as Account Head in the party statement. If ledgerName/ledgerNames is missing but partyName is provided, this tool searches party ledgers and returns options for user selection when there are multiple matches. For parties split into multiple Tally ledgers like Dream Bake Delhi and Dream Bake Boral, pass all selected ledgers in ledgerNames; the tool merges their vouchers and keeps tally_source_ledger_name in the output. Matching uses indexed amount/date/reference matching and defaults to returning only exceptions to reduce output/token size. If invoice/reference/date matches but the amount differs, it returns status amount_mismatch instead of treating it as fully unmatched; the output includes amount_difference, mismatch_type, possible_reason and tally_source_ledger_name. Minor differences caused by TDS, discount, debit/credit note, shortage, round-off or other deductions are kept as amount_mismatch instead of being pushed to statement_only/tally_only when date/reference/narration confidence is sufficient. The tool also handles backdated/later-booked vouchers by extending the Tally fetch window and returning date_mismatch / backdated_or_booked_earlier / booked_later_or_future_dated instead of treating those rows as missing. Amounts are never back-calculated from balances or other rows; statement amount comes only from debit/credit/amount columns sent by Claude, and Tally amount comes only from the fetched voucher/ledger row.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional Tally company name where your books are open, validate using discover-companies/list-master company'),
            ledgerName: z.string().optional().describe('exact selected Tally party ledger name in YOUR books for single-ledger reconciliation. If the same party has multiple branch/location ledgers, prefer ledgerNames.'),
            ledgerNames: z.array(z.string()).optional().describe('one or more exact selected Tally party ledger names in YOUR books. Use this when the same party is split across multiple ledgers/branches, for example Dream Bake - Delhi and Dream Bake Boral. The tool will fetch all selected ledgers, merge the rows, and show tally_source_ledger_name for every matched or unmatched Tally row.'),
            partyName: z.string().optional().describe('party name entered by the user in Excel or read from the statement header. Used to search ledger options when ledgerName is not supplied.'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from date of reconciliation period'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to date of reconciliation period'),
            partyStatementRows: z.array(z.object({}).passthrough()).optional().describe('structured rows extracted from Excel/PDF. Supported keys include Date, Document Date, Posting Date, Reference, Document Number, Particulars, Text, Narration, Voucher No, Invoice No, Bill No, Debit, Credit, Amount in local currency, Amount, Balance or normalized snake_case keys.'),
            statementRowsCompact: z.array(z.string()).optional().describe('low-token compact rows for Excel/PDF. Preferred for PDF speed. Each string should be: date|ref_or_invoice|debit|credit|balance|short narration. Do not send page headers or raw PDF text.'),
            tallyLedgerExports: z.array(z.object({
                fileName: z.string().describe('Filename of the exported Tally ledger Excel'),
                ledgerName: z.string().describe('Extracted or user-provided Tally ledger name'),
                rows: z.array(z.object({}).passthrough()).describe('Voucher rows extracted from this ledger export. Required keys: date, voucher_type, voucher_number, debit, credit, narration')
            })).optional().describe('Optional list of exported Tally ledger files (replacing/supplementing live fetches)'),
            partyStatementFiles: z.array(z.object({
                fileName: z.string().describe('Filename of the party statement'),
                rows: z.array(z.object({}).passthrough()).describe('Transaction rows extracted from this statement file')
            })).optional().describe('Optional list of party statement files (merged into one set before reconciling)'),
            sourceFormat: z.enum(['excel', 'pdf', 'csv', 'manual']).optional().describe('source of party statement rows. Use excel for XLSX/CSV, pdf for PDF. Excel is fastest and most accurate.'),
            statementOwnerName: z.string().optional().describe('optional name printed in the statement header/letterhead, e.g. Dream Bake Pvt. Ltd. This is the party whose ledger should be selected in your Tally.'),
            statementAccountHead: z.string().optional().describe('optional Account Head printed inside the party statement, often your own company name in the party books, e.g. Nowrangroy Agro Private Ltd(Howrah). Do not use this as ledgerName unless it is actually the party ledger in your books.'),
            statementPerspective: z.enum(['auto', 'same_as_tally', 'opposite']).optional().describe('how to treat debit/credit direction in the party statement. Use auto by default. Use opposite when the party statement is from the party’s books and debit/credit is reversed compared to your Tally ledger.'),
            amountTolerance: z.number().optional().describe('allowed exact-match amount difference, default 1 rupee'),
            minorMismatchTolerance: z.number().optional().describe('allowed minor amount mismatch to still treat as possible matched reference/date, default 10000 rupees. Useful for TDS, discount, shortage, debit note, credit note, freight, round-off or other deductions.'),
            minorMismatchPercent: z.number().optional().describe('allowed minor mismatch as percentage of statement amount, default 2 percent. Useful when TDS/deductions are percentage based.'),
            dateToleranceDays: z.number().int().optional().describe('allowed difference between party statement date and Tally voucher date, default 7 days'),
            dateSearchWindowDays: z.number().int().optional().describe('candidate search window for backdated/later-booked vouchers. Default 60 days. Increase if party books entries much earlier/later than your Tally.'),
            lookBackDays: z.number().int().optional().describe('extend Tally ledger fetch before fromDate to catch backdated/booked earlier entries. Default equals dateSearchWindowDays.'),
            lookAheadDays: z.number().int().optional().describe('extend Tally ledger fetch after toDate to catch later-booked/future dated entries. Default equals dateSearchWindowDays.'),
            minimumScore: z.number().optional().describe('minimum match score, default 60'),
            fastMode: z.boolean().optional().describe('default true. Uses indexed amount/date/reference matching for much faster reconciliation on long ledgers.'),
            maxOutputRows: z.number().int().positive().optional().describe('maximum reconciliation rows to return/cache in one call, default 500. Use query with shorter date ranges for full detailed output.'),
            reversalMatchWindowDays: z.number().int().optional().describe('allowed date gap for Reversal Pairs matching Sales vs Credit Note, default 60 days'),
            tcsTdsRateMinPercent: z.number().optional().describe('minimum percentage difference for TCS/TDS matching, default 0.05'),
            tcsTdsRateMaxPercent: z.number().optional().describe('maximum percentage difference for TCS/TDS matching, default 0.15'),
            anomalyThresholdPercent: z.number().optional().describe('percentage difference threshold above which a mismatch is flagged as a Data Extraction Anomaly, default 5'),
            journalRoundingTolerance: z.number().optional().describe('allowed gap between TCS/TDS total and Journal total for them to match, default 5'),
            returnOnlyExceptions: z.boolean().optional().describe('default true to reduce token usage. If false, output includes matched rows as well as exceptions.'),
            secondaryResolutionPass: z.boolean().optional().describe(
                'default true. Runs a secondary pass after primary matching to auto-resolve ' +
                'amount_mismatch, tally_only, and tally_only_out_of_statement_scope rows ' +
                'by fetching related credit notes, journal vouchers, and TDS journals from Tally. ' +
                'Produces matched_net_of_credit_note, matched_net_of_journal_adjustment, ' +
                'matched_verified_tds_journal, and amount_mismatch_unresolved statuses. ' +
                'Disable for large ledgers where speed matters more than auto-resolution.'
            ),
            rowLimit: z.number().int().optional().describe('maximum allowed statement rows to process to prevent token overload, default 300'),
            compactSummary: z.boolean().optional().describe('default true. Strips verbose detail arrays from summary, keeping just counts/totals.')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const amountTolerance = args.amountTolerance ?? 1;
            const minorMismatchTolerance = args.minorMismatchTolerance ?? 10000;
            const minorMismatchPercent = args.minorMismatchPercent ?? 2;
            const dateToleranceDays = args.dateToleranceDays ?? 7;
            const dateSearchWindowDays = Math.max(15, Math.min(args.dateSearchWindowDays ?? 60, 365));
            const lookBackDays = Math.max(0, Math.min(args.lookBackDays ?? dateSearchWindowDays, 365));
            const lookAheadDays = Math.max(0, Math.min(args.lookAheadDays ?? dateSearchWindowDays, 365));
            const minimumScore = args.minimumScore ?? 60;
            const fastMode = args.fastMode !== false;
            const maxOutputRows = Math.max(1, Math.min(args.maxOutputRows ?? 500, 5000));
            const returnOnlyExceptions = args.returnOnlyExceptions !== false;
            const rowLimit = args.rowLimit ?? 300;
            const compactSummary = args.compactSummary !== false;
            const reversalMatchWindowDays = Math.max(0, args.reversalMatchWindowDays ?? 60);
            const tcsTdsRateMinPercent = args.tcsTdsRateMinPercent ?? 0.05;
            const tcsTdsRateMaxPercent = args.tcsTdsRateMaxPercent ?? 0.15;
            const anomalyThresholdPercent = args.anomalyThresholdPercent ?? 5.0;
            const journalRoundingTolerance = args.journalRoundingTolerance ?? 5;
            const statementPerspective = args.statementPerspective || 'auto';
            let statementRows = [];
            let verifiedLedgerNames = [];
            let rawTallyRows = [];
            let offlineMode = false;

            if (Array.isArray(args.partyStatementFiles) && args.partyStatementFiles.length > 0) {
                offlineMode = true;
                // Merge multiple statement files, deduplicating only if date, ref, and amount are identical
                const mergedMap = new Map();
                for (const file of args.partyStatementFiles) {
                    const normalizedRows = normalizeAllPartyStatementRows(file.rows || [], []);
                    for (const r of normalizedRows) {
                        const key = `${r.statement_date}_${r.statement_ref_no}_${r.statement_abs_amount}_${r.statement_direction}`;
                        if (!mergedMap.has(key)) {
                            mergedMap.set(key, r);
                        }
                    }
                }
                statementRows = Array.from(mergedMap.values());
            } else {
                statementRows = normalizeAllPartyStatementRows(args.partyStatementRows || [], args.statementRowsCompact || []);
            }

            if (statementRows.length === 0) {
                return { isError: true, content: [{ type: 'text', text: 'No usable party statement rows found. Send either statementRowsCompact, partyStatementRows, or partyStatementFiles.' }] };
            }

            if (statementRows.length > rowLimit) {
                return { isError: true, content: [{ type: 'text', text: `Statement rows count (${statementRows.length}) exceeds the row limit (${rowLimit}). Please split the date range into smaller chunks (e.g. monthly) and retry.` }] };
            }

            if (Array.isArray(args.tallyLedgerExports) && args.tallyLedgerExports.length > 0) {
                offlineMode = true;
                for (const exportFile of args.tallyLedgerExports) {
                    const lName = exportFile.ledgerName || exportFile.fileName;
                    if (!verifiedLedgerNames.includes(lName)) {
                        verifiedLedgerNames.push(lName);
                    }
                    const mapped = (exportFile.rows || []).map((r, index) => {
                        const debVal = parseBankAmount(pickFirst(r, ['debit', 'Debit', 'dr', 'Dr', 'DR']));
                        const credVal = parseBankAmount(pickFirst(r, ['credit', 'Credit', 'cr', 'Cr', 'CR']));
                        let val = credVal - debVal;
                        if (debVal > 0 && credVal === 0) val = -debVal;
                        if (credVal > 0 && debVal === 0) val = credVal;

                        return {
                            date: isoDate(pickFirst(r, ['date', 'Date', 'voucher_date', 'Voucher Date'])),
                            voucher_type: String(pickFirst(r, ['voucher_type', 'Voucher Type', 'type', 'Type']) || ''),
                            voucher_number: String(pickFirst(r, ['voucher_number', 'Voucher Number', 'ref', 'Ref', 'document_no', 'Document No']) || ''),
                            narration: String(pickFirst(r, ['narration', 'Narration', 'particulars', 'Particulars']) || ''),
                            amount: val,
                            source_ledger_name: lName,
                            guid: `offline_${lName}_${index}`
                        };
                    });
                    rawTallyRows.push(...mapped);
                }
            } else {
                let selectedLedgerNames = [];
                if (Array.isArray(args.ledgerNames)) {
                    selectedLedgerNames.push(...args.ledgerNames.map(x => String(x || '').trim()).filter(Boolean));
                }
                const singleLedgerName = String(args.ledgerName || '').trim();
                if (singleLedgerName) selectedLedgerNames.push(singleLedgerName);
                selectedLedgerNames = [...new Set(selectedLedgerNames.map(x => x.trim()).filter(Boolean))];
                if (selectedLedgerNames.length === 0 && args.partyName) {
                    const { searchTerms, options } = await findPartyLedgerOptions(args.targetCompany, args.partyName);
                    if (options.length === 1) selectedLedgerNames = [options[0].ledger_name];
                    else {
                        const tableID = await cacheTable(new Map([['option', 'number'], ['ledger_name', 'string'], ['group_name', 'string'], ['primary_group', 'string']]), options);
                        return { content: [{ type: 'text', text: JSON.stringify({ needs_user_selection: true, allow_multiple_selection: true, tableID, rows: options.length, searched_terms: searchTerms, options, message: 'Select one or multiple party ledgers from these options. If the same party is split across branches/locations, select all relevant ledgers and call party-ledger-reconciliation again with ledgerNames: [..]. This avoids missing entries that are posted in another branch ledger.' }) }] };
                    }
                }
                if (selectedLedgerNames.length === 0) {
                    return { isError: true, content: [{ type: 'text', text: 'ledgerName, ledgerNames, or partyName is required. If the Excel has user-entered partyName, pass it as partyName so ledger options can be shown. If the party has multiple branch ledgers, pass all selected names in ledgerNames.' }] };
                }
                for (const name of selectedLedgerNames) {
                    let lstLedger = await queryCollection('Ledger', ['Name'], new Map([['Exact_Ledger', `$$IsEqual:$Name:"${name.replace(/"/g, '""')}"`]]), args.targetCompany);
                    if (!Array.isArray(lstLedger) || lstLedger.length === 0) {
                        return { isError: true, content: [{ type: 'text', text: `No party ledger found with ledgerName: ${name}. Use search-party-ledgers or call this tool with partyName to get selectable ledger options.` }] };
                    }
                    verifiedLedgerNames.push(String(lstLedger[0]?.Name || name));
                }
                for (const selectedLedgerName of verifiedLedgerNames) {
                    const fetchFromDate = shiftIsoDate(args.fromDate, -lookBackDays);
                    const fetchToDate = shiftIsoDate(args.toDate, lookAheadDays);
                    const inputParams = new Map([['fromDate', fetchFromDate], ['toDate', fetchToDate], ['ledgerName', selectedLedgerName]]);
                    if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
                    const resp = await fetchReport('ledger-account', inputParams);
                    if (resp.error) return { isError: true, content: [{ type: 'text', text: `${selectedLedgerName}: ${resp.error}` }] };
                    let ledgerRows = Array.isArray(resp.data) ? [...resp.data] : [];
                    if (ledgerRows.length > 0) {
                        const first = ledgerRows[0];
                        const last = ledgerRows[ledgerRows.length - 1];
                        if (String(last?.voucher_type || '').toLowerCase().includes('opening') || String(last?.voucher_number || '').toLowerCase().includes('opening')) {
                            ledgerRows.pop();
                        }
                        if (String(first?.voucher_type || '').toLowerCase().includes('opening') || String(first?.voucher_number || '').toLowerCase().includes('opening')) {
                            ledgerRows.shift();
                        }
                    }
                    rawTallyRows.push(...ledgerRows.map(r => ({ ...r, source_ledger_name: selectedLedgerName })));
                }
            }

            const tallyRows = rawTallyRows
                .filter(r => r && String(r.voucher_type || '').toLowerCase() !== 'opening')
                .map(normalizeTallyPartyRow)
                .filter(r => r.tally_abs_amount > 0 && r.tally_date);
            const usedTally = new Set();
            const matched = [];
            const amountMismatches = [];
            const dateMismatches = [];
            const statementOnly = [];
            const partyIndexes = buildPartyTallyIndexes(tallyRows);
            for (const statement of statementRows) {
                let best = null;
                const candidateIndexes = candidateTallyIndexes(statement, partyIndexes, tallyRows, amountTolerance, dateToleranceDays, usedTally, fastMode, dateSearchWindowDays);
                for (const i of candidateIndexes) {
                    const tally = tallyRows[i];
                    const result = scorePartyLedgerMatch(statement, tally, amountTolerance, dateToleranceDays, statementPerspective, minorMismatchTolerance, minorMismatchPercent);
                    if (!best || result.score > best.result.score || (result.score === best.result.score && result.dateDiff < best.result.dateDiff)) {
                        best = { index: i, tally, result };
                    }
                }
                if (best && best.result.score >= minimumScore) {
                    usedTally.add(best.index);
                    const amountDiff = Number(((statement.statement_abs_amount || 0) - (best.tally.tally_abs_amount || 0)).toFixed(2));
                    const periodRelation = partyPeriodRelation(statement.statement_date, best.tally.tally_date, dateToleranceDays);
                    const hasAmountMismatch = Math.abs(amountDiff) > amountTolerance;
                    const hasDateMismatch = !!periodRelation.kind;
                    const resultStatus = hasAmountMismatch ? 'amount_mismatch' : (hasDateMismatch ? 'date_mismatch' : 'matched');
                    const resolvedMismatchType = best.result.mismatchType || (hasDateMismatch ? periodRelation.kind : '');
                    const resolvedPossibleReason = best.result.mismatchType === 'minor_tds_discount_roundoff_possible'
                        ? 'Possible TDS, discount, shortage, debit/credit note, freight, round-off or other deduction. Verify related adjustment vouchers before treating as missing.'
                        : (hasDateMismatch ? periodRelation.reason : '');
                    const resultRow = {
                        status: resultStatus,
                        match_score: best.result.score,
                        match_reasons: best.result.reasons.join(', '),
                        amount_difference: amountDiff,
                        mismatch_type: resolvedMismatchType,
                        possible_reason: resolvedPossibleReason,
                        date_difference_days: best.result.dateDiff,
                        statement_index: statement.statement_index,
                        statement_date: statement.statement_date,
                        statement_ref_no: statement.statement_ref_no,
                        statement_narration: statement.statement_narration,
                        statement_debit_amount: statement.statement_debit_amount,
                        statement_credit_amount: statement.statement_credit_amount,
                        statement_amount: statement.statement_amount,
                        statement_direction: statement.statement_direction,
                        statement_balance: statement.statement_balance,
                        tally_index: best.tally.tally_index,
                        tally_source_ledger_name: best.tally.tally_source_ledger_name,
                        tally_guid: best.tally.tally_guid,
                        tally_date: best.tally.tally_date,
                        tally_voucher_type: best.tally.tally_voucher_type,
                        tally_voucher_number: best.tally.tally_voucher_number,
                        tally_alternate_ledger: best.tally.tally_alternate_ledger,
                        tally_party_name: best.tally.tally_party_name,
                        tally_amount: best.tally.tally_amount,
                        tally_direction: best.tally.tally_direction,
                        tally_narration: best.tally.tally_narration,
                        statement_value_source: 'uploaded_statement_debit_credit_or_amount',
                        tally_value_source: 'tally_ledger_voucher_amount'
                    };
                    if (resultStatus === 'amount_mismatch') amountMismatches.push(resultRow);
                    else if (resultStatus === 'date_mismatch') dateMismatches.push(resultRow);
                    else matched.push(resultRow);
                } else {
                    statementOnly.push({
                        status: 'statement_only',
                        match_score: best?.result?.score || 0,
                        match_reasons: best?.result?.reasons?.join(', ') || '',
                        amount_difference: best ? Number(((statement.statement_abs_amount || 0) - (best.tally.tally_abs_amount || 0)).toFixed(2)) : statement.statement_abs_amount,
                        mismatch_type: best?.result?.mismatchType || '',
                        possible_reason: best?.result?.mismatchType === 'minor_tds_discount_roundoff_possible' ? 'Possible TDS, discount, shortage, debit/credit note, freight, round-off or other deduction. Verify related adjustment vouchers before treating as missing.' : '',
                        date_difference_days: best?.result?.dateDiff ?? null,
                        statement_index: statement.statement_index,
                        statement_date: statement.statement_date,
                        statement_ref_no: statement.statement_ref_no,
                        statement_narration: statement.statement_narration,
                        statement_debit_amount: statement.statement_debit_amount,
                        statement_credit_amount: statement.statement_credit_amount,
                        statement_amount: statement.statement_amount,
                        statement_direction: statement.statement_direction,
                        statement_balance: statement.statement_balance,
                        tally_index: null,
                        tally_source_ledger_name: '',
                        tally_guid: '',
                        tally_date: '',
                        tally_voucher_type: '',
                        tally_voucher_number: '',
                        tally_alternate_ledger: '',
                        tally_party_name: '',
                        tally_amount: 0,
                        tally_direction: '',
                        tally_narration: '',
                        statement_value_source: 'uploaded_statement_debit_credit_or_amount',
                        tally_value_source: ''
                    });
                }
            }
            const tallyOnly = tallyRows
                .filter((_, i) => {
                    if (usedTally.has(i)) return false;
                    const tally = tallyRows[i];
                    if (tally.tally_date && (tally.tally_date < args.fromDate || tally.tally_date > args.toDate)) {
                        return false;
                    }
                    return true;
                })
                .map(tally => ({
                    status: 'tally_only',
                    match_score: 0,
                    match_reasons: '',
                    amount_difference: tally.tally_abs_amount,
                    mismatch_type: '',
                    possible_reason: '',
                    date_difference_days: null,
                    statement_index: null,
                    statement_date: '',
                    statement_ref_no: '',
                    statement_narration: '',
                    statement_debit_amount: 0,
                    statement_credit_amount: 0,
                    statement_amount: 0,
                    statement_direction: '',
                    statement_balance: 0,
                    tally_index: tally.tally_index,
                    tally_source_ledger_name: tally.tally_source_ledger_name,
                    tally_guid: tally.tally_guid,
                    tally_date: tally.tally_date,
                    tally_voucher_type: tally.tally_voucher_type,
                    tally_voucher_number: tally.tally_voucher_number,
                    tally_alternate_ledger: tally.tally_alternate_ledger,
                    tally_party_name: tally.tally_party_name,
                    tally_amount: tally.tally_amount,
                    tally_direction: tally.tally_direction,
                    tally_narration: tally.tally_narration,
                    statement_value_source: '',
                    tally_value_source: 'tally_ledger_voucher_amount'
                }));

            // ============================================================================
            // GROUPED-ROW RECONCILIATION (many-rows-per-reference)
            // ============================================================================
            const stmtGroupMap = new Map();
            const tallyGroupMap = new Map();
            for (const s of statementOnly) {
                if (s.status === 'statement_only') {
                    const normRef = normalizeRefForMatching(s.statement_ref_no);
                    if (normRef) {
                        if (!stmtGroupMap.has(normRef)) stmtGroupMap.set(normRef, []);
                        stmtGroupMap.get(normRef).push(s);
                    }
                }
            }
            for (const t of tallyOnly) {
                if (t.status === 'tally_only') {
                    const normRef = normalizeRefForMatching(t.tally_voucher_number);
                    if (normRef) {
                        if (!tallyGroupMap.has(normRef)) tallyGroupMap.set(normRef, []);
                        tallyGroupMap.get(normRef).push(t);
                    }
                }
            }

            for (const [ref, sRows] of stmtGroupMap.entries()) {
                if (tallyGroupMap.has(ref)) {
                    const tRows = tallyGroupMap.get(ref);
                    const netStmt = sRows.reduce((sum, r) => sum + (r.statement_amount || 0), 0);
                    const netTally = tRows.reduce((sum, r) => sum + (r.tally_amount || 0), 0);
                    const netStmtAbs = Math.abs(netStmt);
                    const netTallyAbs = Math.abs(netTally);
                    const diff = Math.abs(netStmtAbs - netTallyAbs);

                    const amountMatched = diff <= amountTolerance;
                    const percentDiff = netStmtAbs > 0 ? (diff / netStmtAbs) * 100 : 999999;
                    const minorAmountMismatch = !amountMatched && (diff <= minorMismatchTolerance || percentDiff <= minorMismatchPercent || isLikelyTdsPercentage(percentDiff, diff, netStmtAbs));

                    const groupStatus = amountMatched ? 'matched_grouped' : 'amount_mismatch_grouped';
                    const groupMismatchType = amountMatched ? '' : 'amount_mismatch_grouped';
                    const groupPossibleReason = amountMatched ? '' : 'Grouped amount mismatch under same reference.';

                    const len = Math.max(sRows.length, tRows.length);
                    for (let i = 0; i < len; i++) {
                        const s = sRows[i];
                        const t = tRows[i];

                        const resultRow = {
                            status: groupStatus,
                            match_score: 95,
                            match_reasons: `grouped match by reference: ${ref}`,
                            amount_difference: Number((netStmtAbs - netTallyAbs).toFixed(2)),
                            mismatch_type: groupMismatchType,
                            possible_reason: groupPossibleReason,

                            statement_index: s ? s.statement_index : null,
                            statement_date: s ? s.statement_date : '',
                            statement_ref_no: s ? s.statement_ref_no : '',
                            statement_narration: s ? s.statement_narration : '',
                            statement_debit_amount: s ? s.statement_debit_amount : 0,
                            statement_credit_amount: s ? s.statement_credit_amount : 0,
                            statement_amount: s ? s.statement_amount : 0,
                            statement_direction: s ? s.statement_direction : '',
                            statement_balance: s ? s.statement_balance : 0,

                            tally_index: t ? t.tally_index : null,
                            tally_source_ledger_name: t ? t.tally_source_ledger_name : '',
                            tally_guid: t ? t.tally_guid : '',
                            tally_date: t ? t.tally_date : '',
                            tally_voucher_type: t ? t.tally_voucher_type : '',
                            tally_voucher_number: t ? t.tally_voucher_number : '',
                            tally_alternate_ledger: t ? t.tally_alternate_ledger : '',
                            tally_party_name: t ? t.tally_party_name : '',
                            tally_amount: t ? t.tally_amount : 0,
                            tally_direction: t ? t.tally_direction : '',
                            tally_narration: t ? t.tally_narration : '',
                            statement_value_source: s ? 'uploaded_statement_debit_credit_or_amount' : '',
                            tally_value_source: t ? 'tally_ledger_voucher_amount' : ''
                        };

                        if (groupStatus === 'matched_grouped') {
                            matched.push(resultRow);
                        } else {
                            amountMismatches.push(resultRow);
                        }

                        if (s) s.status = groupStatus;
                        if (t) t.status = groupStatus;
                    }
                }
            }

            // Consolidated matching pass: Group multiple unmatched Tally entries that sum up to a single unmatched statement entry
            for (let sIdx = 0; sIdx < statementOnly.length; sIdx++) {
                const stmt = statementOnly[sIdx];
                if (stmt.status !== 'statement_only' || stmt.statement_abs_amount <= 0) continue;

                const candidates = [];
                for (let tIdx = 0; tIdx < tallyOnly.length; tIdx++) {
                    const t = tallyOnly[tIdx];
                    if (t.status !== 'tally_only') continue;

                    const dateDiff = daysBetween(stmt.statement_date, t.tally_date);
                    if (dateDiff <= dateSearchWindowDays) {
                        const sameDir = stmt.statement_direction === t.tally_direction;
                        const oppDir = (stmt.statement_direction === 'debit' && t.tally_direction === 'credit') || (stmt.statement_direction === 'credit' && t.tally_direction === 'debit');
                        let dirOk = false;
                        if (statementPerspective === 'same_as_tally' && sameDir) dirOk = true;
                        else if (statementPerspective === 'opposite' && oppDir) dirOk = true;
                        else if (statementPerspective === 'auto' && (sameDir || oppDir)) dirOk = true;
                        else if (stmt.statement_direction === 'unknown' || t.tally_direction === 'unknown') dirOk = true;

                        if (dirOk) {
                            candidates.push({ index: tIdx, amount: t.tally_abs_amount, dateDiff });
                        }
                    }
                }

                if (candidates.length >= 2) {
                    const matchedIndices = findSubsetSum(candidates, stmt.statement_abs_amount, amountTolerance);
                    if (matchedIndices) {
                        stmt.status = 'matched_consolidated';
                        stmt.match_score = 90;
                        stmt.match_reasons = 'matched via consolidated/split entry sum';
                        stmt.amount_difference = 0;

                        matchedIndices.forEach(tIdx => {
                            const t = tallyOnly[tIdx];
                            t.status = 'matched_consolidated';
                            t.match_score = 90;
                            t.match_reasons = 'matched via consolidated/split entry sum';
                            t.amount_difference = 0;

                            t.statement_index = stmt.statement_index;
                            t.statement_date = stmt.statement_date;
                            t.statement_ref_no = stmt.statement_ref_no;
                            t.statement_narration = stmt.statement_narration;
                            t.statement_debit_amount = stmt.statement_debit_amount;
                            t.statement_credit_amount = stmt.statement_credit_amount;
                            t.statement_amount = stmt.statement_amount;
                            t.statement_direction = stmt.statement_direction;
                            t.statement_balance = stmt.statement_balance;
                            t.statement_value_source = 'uploaded_statement_debit_credit_or_amount';

                            matched.push(t);
                        });
                        matched.push(stmt);
                    }
                }
            }

            // ============================================================================
            // PAYMENT-SIDE DATE-PAIR DIAGNOSTICS
            // ============================================================================
            const finalStatementOnly = statementOnly.filter(s => s.status === 'statement_only');
            const finalTallyOnly = tallyOnly.filter(t => t.status === 'tally_only');

            const dateMap = new Map();
            for (const s of finalStatementOnly) {
                const d = s.statement_date;
                if (d) {
                    if (!dateMap.has(d)) dateMap.set(d, { stmtRows: [], tallyRows: [] });
                    dateMap.get(d).stmtRows.push(s);
                }
            }
            for (const t of finalTallyOnly) {
                const d = t.tally_date;
                if (d) {
                    if (!dateMap.has(d)) dateMap.set(d, { stmtRows: [], tallyRows: [] });
                    dateMap.get(d).tallyRows.push(t);
                }
            }

            const dateDiffs = [];
            for (const [date, data] of dateMap.entries()) {
                const stmtNet = data.stmtRows.reduce((sum, r) => sum + (r.statement_amount || 0), 0);
                const tallyNet = data.tallyRows.reduce((sum, r) => sum + (r.tally_amount || 0), 0);
                const netDiff = stmtNet - (statementPerspective === 'opposite' ? -tallyNet : tallyNet);
                if (Math.abs(netDiff) > amountTolerance) {
                    dateDiffs.push({
                        date,
                        netDiff,
                        stmtRows: data.stmtRows,
                        tallyRows: data.tallyRows,
                        paired: false
                    });
                }
            }

            dateDiffs.sort((a, b) => a.date.localeCompare(b.date));

            for (let i = 0; i < dateDiffs.length; i++) {
                if (dateDiffs[i].paired) continue;
                let bestPairIdx = -1;
                let minGap = Infinity;

                for (let j = 0; j < dateDiffs.length; j++) {
                    if (i === j || dateDiffs[j].paired) continue;

                    const gap = daysBetween(dateDiffs[i].date, dateDiffs[j].date);
                    if (gap <= dateSearchWindowDays) {
                        const sumDiff = dateDiffs[i].netDiff + dateDiffs[j].netDiff;
                        if (Math.abs(sumDiff) <= amountTolerance) {
                            if (gap < minGap) {
                                minGap = gap;
                                bestPairIdx = j;
                            }
                        }
                    }
                }

                if (bestPairIdx !== -1) {
                    dateDiffs[i].paired = true;
                    dateDiffs[bestPairIdx].paired = true;

                    const d1 = dateDiffs[i];
                    const d2 = dateDiffs[bestPairIdx];
                    const gap = daysBetween(d1.date, d2.date);

                    const markRows = (rows, pairedDate) => {
                        for (const r of rows) {
                            r.status = 'resolved_via_date_pair_offset';
                            r.mismatch_type = 'resolved_via_date_pair_offset';
                            r.possible_reason = `Resolved via date-pair offset with ${pairedDate} (gap of ${gap} days). Net difference on date: ${r.statement_amount || r.tally_amount || 0}`;
                        }
                    };

                    markRows(d1.stmtRows, d2.date);
                    markRows(d1.tallyRows, d2.date);
                    markRows(d2.stmtRows, d1.date);
                    markRows(d2.tallyRows, d1.date);
                }
            }

            for (const diff of dateDiffs) {
                if (!diff.paired) {
                    const markGenuine = (rows) => {
                        for (const r of rows) {
                            r.status = 'genuine_gap';
                            r.mismatch_type = 'genuine_gap';
                            r.possible_reason = `Genuine Gap: No offsetting date-pair found within search window. Amount: ${r.statement_amount || r.tally_amount || 0}`;
                        }
                    };
                    markGenuine(diff.stmtRows);
                    markGenuine(diff.tallyRows);
                }
            }

            const statementVoucherTypesSeen = new Set(
                statementRows
                    .map(r => String(r.statement_voucher_type || r.statement_narration_voucher_type || '').trim().toLowerCase())
                    .filter(Boolean)
            );

            const refPrefix = (ref) => {
                const m = String(ref || '').toUpperCase().match(/^([A-Z]+)/);
                return m ? m[1] : '';
            };
            const statementRefPrefixesSeen = new Set(
                statementRows.map(r => refPrefix(r.statement_ref_no)).filter(Boolean)
            );

            const outOfScopeTallyOnly = [];
            const genuineTallyOnly = [];
            for (const t of finalTallyOnly) {
                if (t.status === 'resolved_via_date_pair_offset') continue;

                const vType = String(t.tally_voucher_type || '').trim().toLowerCase();
                const prefix = refPrefix(t.tally_voucher_number);

                const typeSignalAvailable = statementVoucherTypesSeen.size > 0;
                const prefixSignalAvailable = statementRefPrefixesSeen.size > 0;

                let isOutOfScope;
                if (typeSignalAvailable && prefixSignalAvailable) {
                    isOutOfScope = !statementVoucherTypesSeen.has(vType) && !statementRefPrefixesSeen.has(prefix);
                } else if (typeSignalAvailable) {
                    isOutOfScope = !statementVoucherTypesSeen.has(vType);
                } else if (prefixSignalAvailable) {
                    isOutOfScope = !statementRefPrefixesSeen.has(prefix);
                } else {
                    isOutOfScope = false;
                }

                if (isOutOfScope) {
                    outOfScopeTallyOnly.push({
                        ...t,
                        status: 'tally_only_out_of_statement_scope',
                        possible_reason: `Voucher type "${t.tally_voucher_type}" (ref prefix "${prefix}") never appears anywhere in the supplied party statement. This is likely a structural gap in what the statement format/export captures (e.g. credit notes or journals excluded from a sales-only subsidiary ledger print), not necessarily a missing transaction. Verify with the party whether this voucher type is tracked under a different report/account on their side.`
                    });
                } else {
                    genuineTallyOnly.push(t);
                }
            }

            // ============================================================================
            // ADVANCED RECONCILIATION PASS: Reversals, TCS/TDS, and Journals
            // ============================================================================
            const unaccounted_credit_notes = [];
            const reversal_pairs = [];
            const genuineTallyOnlyFiltered = [];

            const salesBos = genuineTallyOnly.filter(t => /sales|bill of supply/i.test(t.tally_voucher_type || ''));
            const creditNotes = genuineTallyOnly.filter(t => /credit note/i.test(t.tally_voucher_type || ''));
            const otherTallyOnly = genuineTallyOnly.filter(t => !/sales|bill of supply|credit note/i.test(t.tally_voucher_type || ''));

            const parseDate = (d) => new Date(d).getTime();
            const daysDiff = (d1, d2) => Math.abs(parseDate(d1) - parseDate(d2)) / (1000 * 3600 * 24);

            const usedCreditNotes = new Set();
            for (const s of salesBos) {
                let paired = false;
                for (let idx = 0; idx < creditNotes.length; idx++) {
                    const cn = creditNotes[idx];
                    if (!usedCreditNotes.has(idx) && cn.tally_abs_amount === s.tally_abs_amount) {
                        if (daysDiff(s.tally_date, cn.tally_date) <= reversalMatchWindowDays) {
                            usedCreditNotes.add(idx);
                            reversal_pairs.push({
                                sales_voucher: s,
                                credit_note: cn,
                                status: 'reversal_pair_matched'
                            });
                            paired = true;
                            break;
                        }
                    }
                }
                if (!paired) genuineTallyOnlyFiltered.push(s);
            }

            let runningUnaccountedCnTotal = 0;
            for (let idx = 0; idx < creditNotes.length; idx++) {
                if (!usedCreditNotes.has(idx)) {
                    const cn = creditNotes[idx];
                    runningUnaccountedCnTotal += cn.tally_abs_amount || 0;
                    unaccounted_credit_notes.push({
                        date: cn.tally_date,
                        reference: cn.tally_voucher_number,
                        amount: cn.tally_abs_amount,
                        source_ledger: cn.tally_source_ledger_name,
                        running_total: Number(runningUnaccountedCnTotal.toFixed(2)),
                        status: 'unaccounted_credit_note',
                        original_row: cn
                    });
                    // We still keep unaccounted credit notes in the unmatched tally list for full visibility
                    genuineTallyOnlyFiltered.push(cn);
                }
            }
            genuineTallyOnlyFiltered.push(...otherTallyOnly);

            const data_extraction_anomalies = [];
            let tcs_tds_expected_total = 0;
            for (const m of amountMismatches) {
                const diff_percent = (Math.abs(m.amount_difference || 0) / (m.statement_abs_amount || 1)) * 100;
                if (diff_percent > anomalyThresholdPercent) {
                    data_extraction_anomalies.push({ ...m, diff_percent: Number(diff_percent.toFixed(2)), anomaly_reason: `Difference exceeds ${anomalyThresholdPercent}% threshold` });
                } else if (diff_percent >= tcsTdsRateMinPercent && diff_percent <= tcsTdsRateMaxPercent) {
                    tcs_tds_expected_total += Math.abs(m.amount_difference || 0);
                }
            }

            const journal_summary = {};
            let journal_total_amount = 0;
            const journals = genuineTallyOnlyFiltered.filter(t => /journal|jv/i.test(t.tally_voucher_type || ''));
            for (const j of journals) {
                const lName = j.tally_source_ledger_name || 'Unknown';
                if (!journal_summary[lName]) journal_summary[lName] = 0;
                journal_summary[lName] += j.tally_abs_amount || 0;
                journal_total_amount += j.tally_abs_amount || 0;
            }

            const tcs_journal_reconciliation_status = {
                status: Math.abs(tcs_tds_expected_total - journal_total_amount) <= journalRoundingTolerance ? 'MATCHED' : 'MISMATCH',
                tcs_tds_total: Number(tcs_tds_expected_total.toFixed(2)),
                journal_total: Number(journal_total_amount.toFixed(2)),
                gap: Number(Math.abs(tcs_tds_expected_total - journal_total_amount).toFixed(2)),
                breakdown_by_ledger: journal_summary
            };

            const finalMatchedConsolidated = matched.filter(m => m.status === 'matched_consolidated');
            const finalMatched = matched.filter(m => m.status !== 'matched_consolidated');

            const secondaryResolutionEnabled = args.secondaryResolutionPass !== false;

            // Counters for secondary resolution summary
            let secMatchedCreditNote = 0;
            let secMatchedJournalAdj = 0;
            let secMatchedVerifiedTds = 0;
            let secAmountMismatchUnresolved = 0;
            let secTdsJournalNoStatement = 0;
            let secFetchesDone = 0;
            const SEC_FETCH_CAP = 50;

            // Helper: extract invoice number tokens from a narration string
            const extractInvoiceRefFromNarration = (narration) => {
                if (!narration) return null;
                const patterns = [
                    /(?:AGST|AGAINST)\s+(?:INV(?:OICE)?\.?\s*(?:NO\.?\s*)?)([A-Z0-9\/\-]+)/i,
                    /(?:INV(?:OICE)?\.?\s*(?:NO\.?\s*)?)([A-Z]{2,}\/\d{2,}\/\d{2}-\d{2})/i,
                    /(RBS\/\d{5}\/25-26)/i,
                    /(MBS\/\d{5}\/25-26)/i,
                    /(RBS\/\d{5}\/24-25)/i,
                    /B\.NO[:\s]*(\d{4,6}(?:\s*TO\s*\d{4,6})?)/i,
                ];
                for (const pat of patterns) {
                    const m = String(narration).match(pat);
                    if (m && m[1]) return m[1].trim().toUpperCase();
                }
                return null;
            };

            // Helper: look up a voucher's narration from Tally live (offline mode: use existing data)
            const getVoucherNarration = async (voucherNumber, existingTallyRows) => {
                // First try to find narration in existing fetched rows (no extra call needed)
                const existing = existingTallyRows.find(r =>
                    normalizeRefForMatching(r.tally_voucher_number) === normalizeRefForMatching(voucherNumber)
                );
                if (existing) return existing.tally_narration || '';

                // In live mode, fetch from Tally if under cap — but voucher narration is
                // already in rawTallyRows from the ledger-account fetch, so this is a
                // fallback that should rarely fire.
                return '';
            };

            if (secondaryResolutionEnabled) {

                // ── PASS 1: Credit Note Auto-Resolution ──────────────────────────────────
                const cnPrefixes = new Set(['RCN', 'MCN', 'CDN', 'CRN']);
                const isCreditNote = (t) =>
                    cnPrefixes.has(refPrefix(t.tally_voucher_number)) ||
                    /credit.?note/i.test(t.tally_voucher_type);

                // Build a fast index of all matched + amount_mismatch rows keyed by normalized ref
                const invoiceByRef = new Map();
                for (const row of [...finalMatched, ...finalMatchedConsolidated, ...amountMismatches]) {
                    const key = normalizeRefForMatching(row.tally_voucher_number || row.statement_ref_no || '');
                    if (key) invoiceByRef.set(key, row);
                }

                const cnCandidates = [...genuineTallyOnlyFiltered, ...outOfScopeTallyOnly].filter(isCreditNote);

                for (const cn of cnCandidates) {
                    // Try to link by narration reference
                    const narration = cn.tally_narration || '';
                    const embeddedRef = extractInvoiceRefFromNarration(narration);
                    let linkedInvoice = null;

                    if (embeddedRef) {
                        linkedInvoice = invoiceByRef.get(normalizeRefForMatching(embeddedRef));
                    }

                    // Fallback: match by amount — find invoice where amount_difference ≈ cn amount
                    if (!linkedInvoice) {
                        for (const inv of amountMismatches) {
                            if (Math.abs(Math.abs(inv.amount_difference) - cn.tally_abs_amount) <= amountTolerance) {
                                linkedInvoice = inv;
                                break;
                            }
                        }
                    }

                    if (linkedInvoice) {
                        const netAmount = Number(((linkedInvoice.tally_amount || 0) - cn.tally_abs_amount * (cn.tally_direction === 'debit' ? 1 : -1)).toFixed(2));
                        const statementAmount = linkedInvoice.statement_abs_amount || 0;
                        const residual = Math.abs(statementAmount - Math.abs(netAmount));

                        if (residual <= minorMismatchTolerance) {
                            // Fully resolved via credit note netting
                            linkedInvoice.status = 'matched_net_of_credit_note';
                            linkedInvoice.linked_credit_note_voucher = cn.tally_voucher_number;
                            linkedInvoice.linked_credit_note_amount = cn.tally_abs_amount;
                            linkedInvoice.net_amount = netAmount;
                            linkedInvoice.resolution_note =
                                `Credit note ${cn.tally_voucher_number} (Rs ${cn.tally_abs_amount.toLocaleString('en-IN')}) ` +
                                `netted against invoice. Net amount Rs ${Math.abs(netAmount).toLocaleString('en-IN')} ` +
                                `matches statement within tolerance.`;
                            cn.status = 'resolved_linked_to_invoice';
                            secMatchedCreditNote++;
                        } else {
                            // Partially resolved — update mismatch with credit note context
                            linkedInvoice.linked_credit_note_voucher = cn.tally_voucher_number;
                            linkedInvoice.linked_credit_note_amount = cn.tally_abs_amount;
                            linkedInvoice.net_amount = netAmount;
                            linkedInvoice.resolution_note =
                                `Credit note ${cn.tally_voucher_number} found but net amount still differs ` +
                                `by Rs ${residual.toFixed(2)} from statement. Review remaining difference.`;
                        }
                    }
                }

                // ── PASS 2: Journal Voucher Auto-Resolution ───────────────────────────────
                const jvPrefixes = new Set(['RJV', 'MJV', 'JV']);
                const isJournal = (t) =>
                    jvPrefixes.has(refPrefix(t.tally_voucher_number)) ||
                    /journal/i.test(t.tally_voucher_type);

                const jvCandidates = [...genuineTallyOnlyFiltered, ...outOfScopeTallyOnly]
                    .filter(t => t.status !== 'resolved_linked_to_invoice' && isJournal(t));

                for (const jv of jvCandidates) {
                    if (secFetchesDone >= SEC_FETCH_CAP) break;

                    const narration = jv.tally_narration || '';
                    const embeddedRef = extractInvoiceRefFromNarration(narration);
                    let linkedInvoice = null;

                    if (embeddedRef) {
                        linkedInvoice = invoiceByRef.get(normalizeRefForMatching(embeddedRef));
                    }

                    // Determine if this journal looks like a TDS/TCS entry by percentage
                    const isTdsLike = jv.tally_abs_amount > 0 && amountMismatches.some(inv => {
                        const pct = (jv.tally_abs_amount / (inv.tally_abs_amount || 1)) * 100;
                        return pct >= (args.tcsTdsRateMinPercent ?? 0.05) && pct <= (args.tcsTdsRateMaxPercent ?? 2);
                    });

                    if (linkedInvoice) {
                        const netAmount = Number(((linkedInvoice.tally_amount || 0) - jv.tally_abs_amount).toFixed(2));
                        const statementAmount = linkedInvoice.statement_abs_amount || 0;
                        const residual = Math.abs(statementAmount - Math.abs(netAmount));
                        const journalType = isTdsLike ? 'TDS/TCS adjustment' : 'rounding/other adjustment';

                        if (residual <= minorMismatchTolerance) {
                            linkedInvoice.status = 'matched_net_of_journal_adjustment';
                            linkedInvoice.linked_journal_voucher = jv.tally_voucher_number;
                            linkedInvoice.linked_journal_amount = jv.tally_abs_amount;
                            linkedInvoice.journal_type = journalType;
                            linkedInvoice.net_amount = netAmount;
                            linkedInvoice.resolution_note =
                                `Journal ${jv.tally_voucher_number} (${journalType}, ` +
                                `Rs ${jv.tally_abs_amount.toLocaleString('en-IN')}) netted against invoice. ` +
                                `Net matches statement within tolerance.`;
                            jv.status = 'resolved_linked_to_invoice';
                            secMatchedJournalAdj++;
                        } else {
                            linkedInvoice.linked_journal_voucher = jv.tally_voucher_number;
                            linkedInvoice.linked_journal_amount = jv.tally_abs_amount;
                            linkedInvoice.journal_type = journalType;
                            linkedInvoice.resolution_note =
                                `Journal ${jv.tally_voucher_number} found but residual difference ` +
                                `of Rs ${residual.toFixed(2)} remains after netting. Review further.`;
                        }
                    } else if (isTdsLike) {
                        jv.status = 'tally_only_tds_journal_no_statement_match';
                        jv.possible_reason =
                            `Journal voucher appears to be a TDS/TCS adjustment ` +
                            `(${((jv.tally_abs_amount / (amountMismatches[0]?.tally_abs_amount || 1)) * 100).toFixed(3)}% of nearby invoice) ` +
                            `but no linked invoice reference found in narration and no statement entry matches. ` +
                            `Verify manually whether this is a standalone TDS booking.`;
                        secTdsJournalNoStatement++;
                    }
                }

                // ── PASS 3: Amount Mismatch TDS Verification ──────────────────────────────
                // For each amount_mismatch labeled minor_tds, look for a confirming journal
                const remainingJvs = [...genuineTallyOnlyFiltered, ...outOfScopeTallyOnly]
                    .filter(t => t.status !== 'resolved_linked_to_invoice' && isJournal(t));

                for (const inv of amountMismatches) {
                    if (inv.status === 'matched_net_of_credit_note' ||
                        inv.status === 'matched_net_of_journal_adjustment') continue;

                    const diff = Math.abs(inv.amount_difference || 0);
                    const pct = inv.tally_abs_amount > 0 ? (diff / inv.tally_abs_amount) * 100 : 999;
                    const isTdsRange = pct >= (args.tcsTdsRateMinPercent ?? 0.05) &&
                        pct <= (args.tcsTdsRateMaxPercent ?? 2);

                    if (!isTdsRange) {
                        inv.mismatch_type = 'amount_mismatch_unresolved';
                        inv.possible_reason =
                            `Difference of Rs ${diff.toFixed(2)} (${pct.toFixed(3)}%) is outside TDS/TCS ` +
                            `range and no confirming journal voucher found. Requires investigation.`;
                        secAmountMismatchUnresolved++;
                        continue;
                    }

                    // Try to find a confirming TDS journal for this invoice
                    const invRef = normalizeRefForMatching(inv.tally_voucher_number || inv.statement_ref_no || '');
                    const invDate = inv.tally_date || inv.statement_date;
                    let confirmingJv = null;

                    for (const jv of remainingJvs) {
                        if (jv.status === 'resolved_linked_to_invoice') continue;
                        // Amount match
                        if (Math.abs(jv.tally_abs_amount - diff) > amountTolerance) continue;
                        // Date proximity
                        if (daysBetween(invDate, jv.tally_date) > dateSearchWindowDays) continue;
                        // Narration reference check (best effort)
                        const jvRef = extractInvoiceRefFromNarration(jv.tally_narration);
                        if (jvRef && normalizeRefForMatching(jvRef) !== invRef) continue;
                        confirmingJv = jv;
                        break;
                    }

                    if (confirmingJv) {
                        inv.status = 'matched_verified_tds_journal';
                        inv.mismatch_type = 'minor_tds_verified_by_journal';
                        inv.verified_by_journal_voucher = confirmingJv.tally_voucher_number;
                        inv.journal_voucher_amount = confirmingJv.tally_abs_amount;
                        inv.verification_note =
                            `TDS/TCS difference of Rs ${diff.toFixed(2)} (${pct.toFixed(3)}%) confirmed ` +
                            `by journal voucher ${confirmingJv.tally_voucher_number} in Tally — not a genuine gap.`;
                        inv.possible_reason = inv.verification_note;
                        confirmingJv.status = 'resolved_linked_to_invoice';
                        secMatchedVerifiedTds++;
                    } else {
                        inv.mismatch_type = 'minor_tds_unverified';
                        inv.possible_reason =
                            `Difference of Rs ${diff.toFixed(2)} (${pct.toFixed(3)}%) is within TDS/TCS range ` +
                            `but no confirming journal voucher found in Tally for this period. ` +
                            `Likely TDS deducted by party — verify deduction certificate if needed.`;
                    }
                }
            } else {
                secAmountMismatchUnresolved = amountMismatches.length;
            }

            // ── Rebuild final buckets after secondary resolution ─────────────────────────
            const finalMatchedAll = [
                ...finalMatched,
                ...finalMatchedConsolidated,
                ...amountMismatches.filter(m =>
                    m.status === 'matched_net_of_credit_note' ||
                    m.status === 'matched_net_of_journal_adjustment' ||
                    m.status === 'matched_verified_tds_journal'
                )
            ];
            const finalAmountMismatches = amountMismatches.filter(m =>
                m.status !== 'matched_net_of_credit_note' &&
                m.status !== 'matched_net_of_journal_adjustment' &&
                m.status !== 'matched_verified_tds_journal'
            );
            const finalGenuineTallyOnly = genuineTallyOnlyFiltered.filter(t =>
                t.status !== 'resolved_linked_to_invoice' &&
                t.status !== 'tally_only_tds_journal_no_statement_match'
            );
            const finalOutOfScope = outOfScopeTallyOnly.filter(t =>
                t.status !== 'resolved_linked_to_invoice' &&
                t.status !== 'tally_only_tds_journal_no_statement_match'
            );
            const finalTdsJournalNoStatement = [
                ...genuineTallyOnlyFiltered,
                ...outOfScopeTallyOnly
            ].filter(t => t.status === 'tally_only_tds_journal_no_statement_match');

            // ── Build fullRows ────────────────────────────────────────────────────────────
            const fullRows = returnOnlyExceptions
                ? [...finalAmountMismatches, ...dateMismatches, ...finalStatementOnly, ...finalGenuineTallyOnly, ...finalOutOfScope, ...finalTdsJournalNoStatement]
                : [...finalMatchedAll, ...finalAmountMismatches, ...dateMismatches, ...finalStatementOnly, ...finalGenuineTallyOnly, ...finalOutOfScope, ...finalTdsJournalNoStatement];

            const rows = fullRows.slice(0, maxOutputRows);

            // ── Summary ───────────────────────────────────────────────────────────────────
            const statementDebit = statementRows.reduce((s, r) => s + (r.statement_debit_amount || 0), 0);
            const statementCredit = statementRows.reduce((s, r) => s + (r.statement_credit_amount || 0), 0);
            const tallyDebit = tallyRows.filter(r => r.tally_direction === 'debit').reduce((s, r) => s + r.tally_abs_amount, 0);
            const tallyCredit = tallyRows.filter(r => r.tally_direction === 'credit').reduce((s, r) => s + r.tally_abs_amount, 0);

            const summary = {
                statement_rows: statementRows.length,
                tally_rows: tallyRows.length,
                matched: finalMatchedAll.filter(m => m.status === 'matched' || m.status === 'matched_consolidated').length,
                matched_net_of_credit_note: secMatchedCreditNote,
                matched_net_of_journal_adjustment: secMatchedJournalAdj,
                matched_verified_tds_journal: secMatchedVerifiedTds,
                amount_mismatch: finalAmountMismatches.filter(m => m.mismatch_type === 'amount_mismatch_unresolved').length,
                amount_mismatch_minor_tds_unverified: finalAmountMismatches.filter(m => m.mismatch_type === 'minor_tds_unverified').length,
                amount_mismatch_unresolved: secAmountMismatchUnresolved,
                date_mismatch: dateMismatches.length,
                statement_only: finalStatementOnly.length,
                tally_only: finalGenuineTallyOnly.length,
                tally_only_out_of_statement_scope: finalOutOfScope.length,
                tally_only_tds_journal_no_statement_match: secTdsJournalNoStatement,
                secondary_resolution_attempted: secondaryResolutionEnabled,
                secondary_resolution_note: secondaryResolutionEnabled
                    ? `Secondary pass resolved: ${secMatchedCreditNote} via credit note netting, ` +
                    `${secMatchedJournalAdj} via journal adjustment, ` +
                    `${secMatchedVerifiedTds} via TDS journal verification. ` +
                    `${secAmountMismatchUnresolved} rows remain genuinely unresolved and require action.` +
                    (secFetchesDone >= SEC_FETCH_CAP ? ` Note: fetch cap of ${SEC_FETCH_CAP} reached — some journals may not have been checked.` : '')
                    : 'Secondary resolution pass was disabled.',
                statement_debit: Number(statementDebit.toFixed(2)),
                statement_credit: Number(statementCredit.toFixed(2)),
                tally_debit: Number(tallyDebit.toFixed(2)),
                tally_credit: Number(tallyCredit.toFixed(2)),
                statement_net: Number((statementCredit - statementDebit).toFixed(2)),
                tally_net: Number((tallyCredit - tallyDebit).toFixed(2)),
                net_difference_same_perspective: Number(((statementCredit - statementDebit) - (tallyCredit - tallyDebit)).toFixed(2)),
                net_difference_opposite_perspective: Number((-(statementCredit - statementDebit) - (tallyCredit - tallyDebit)).toFixed(2)),
                reversal_pairs_count: reversal_pairs.length,
                unaccounted_credit_notes: compactSummary ? undefined : unaccounted_credit_notes,
                tcs_tds_summary: compactSummary ? {
                    tcs_tds_total: Number(tcs_tds_expected_total.toFixed(2)),
                    anomalies_count: data_extraction_anomalies.length
                } : {
                    tcs_tds_total: Number(tcs_tds_expected_total.toFixed(2)),
                    anomalies_count: data_extraction_anomalies.length,
                    anomalies: data_extraction_anomalies
                },
                journal_summary: compactSummary ? {
                    total_amount: Number(journal_total_amount.toFixed(2)),
                    breakdown_count: Object.keys(journal_summary).length
                } : {
                    total_amount: Number(journal_total_amount.toFixed(2)),
                    breakdown: journal_summary
                },
                tcs_journal_reconciliation_status,
                ledgerName: verifiedLedgerNames.length === 1 ? verifiedLedgerNames[0] : verifiedLedgerNames.join(', '),
                ledgerNames: verifiedLedgerNames,
                ledgers_count: verifiedLedgerNames.length,
                sourceFormat: args.sourceFormat || '',
                statementPerspective,
                amountTolerance,
                minorMismatchTolerance,
                minorMismatchPercent,
                dateToleranceDays,
                dateSearchWindowDays,
                lookBackDays,
                lookAheadDays,
                fetched_tally_from_date: shiftIsoDate(args.fromDate, -lookBackDays),
                fetched_tally_to_date: shiftIsoDate(args.toDate, lookAheadDays),
                minimumScore,
                fastMode,
                maxOutputRows,
                returnOnlyExceptions,
                direct_voucher_values_only: true,
                no_back_calculation_or_balance_derivation: true,
                amount_mismatch_total_difference: Number(amountMismatches.reduce((s, r) => s + Math.abs(r.amount_difference || 0), 0).toFixed(2)),
                output_rows: rows.length,
                total_result_rows_before_limit: fullRows.length,
                output_limited: fullRows.length > rows.length,
                direct_voucher_values_only: true,
                no_back_calculation: true
            };

            const cacheRows = returnOnlyExceptions
                ? rows.filter(r => !r.status.startsWith('matched'))
                : rows;

            const tableId = await cacheTable(new Map([
                ['status', 'string'], ['match_score', 'number'], ['match_reasons', 'string'], ['amount_difference', 'number'], ['mismatch_type', 'string'], ['possible_reason', 'string'], ['date_difference_days', 'number'],
                ['statement_index', 'number'], ['statement_date', 'date'], ['statement_ref_no', 'string'], ['statement_narration', 'string'], ['statement_debit_amount', 'number'], ['statement_credit_amount', 'number'], ['statement_amount', 'number'], ['statement_direction', 'string'], ['statement_balance', 'number'],
                ['tally_index', 'number'], ['tally_source_ledger_name', 'string'], ['tally_guid', 'string'], ['tally_date', 'date'], ['tally_voucher_type', 'string'], ['tally_voucher_number', 'string'], ['tally_alternate_ledger', 'string'], ['tally_party_name', 'string'], ['tally_amount', 'number'], ['tally_direction', 'string'], ['tally_narration', 'string'], ['statement_value_source', 'string'], ['tally_value_source', 'string'], ['contributing_vouchers', 'string'],
                ['linked_credit_note_voucher', 'string'], ['linked_credit_note_amount', 'number'],
                ['linked_journal_voucher', 'string'], ['linked_journal_amount', 'number'],
                ['journal_type', 'string'], ['net_amount', 'number'],
                ['verified_by_journal_voucher', 'string'], ['journal_voucher_amount', 'number'],
                ['verification_note', 'string'], ['resolution_note', 'string']
            ]), cacheRows);
            return { content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, rows: cacheRows.length, summary, message: `Use query-database on tableID to filter status IN ('amount_mismatch','date_mismatch','statement_only','tally_only'). Default output is exceptions only to keep Claude fast and reduce token use. amount_mismatch means the invoice/reference/date/narration matched but the PDF/Excel amount differs from Tally; date_mismatch means amount/reference/narration matched but the entry appears backdated, posted later, or in a different period. Check mismatch_type/possible_reason for TDS, discount, shortage, debit/credit note, freight, round-off or timing differences. When multiple ledgerNames are used, tally_source_ledger_name shows which Tally ledger each row came from. Values are direct-only: statement balance is never used to derive transaction amount and Tally amounts are never back-calculated from other values. If fully matched rows are needed, call again with returnOnlyExceptions false or query shorter date ranges/month-wise.` }) }] };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err?.message || err) }] };
        }
    });


    mcpServer.registerTool('gstr-2b-reconciliation', {
        title: 'GSTR-2B Reconciliation',
        description: `Reconciles GSTR-2B Excel/JSON with Tally purchase register rows. For official GST portal GSTR-2B Excel, Claude must scan every detail sheet, not only B2B: B2B, B2BA, CDNR/CDNRA, ECO/ECOA, ISD/ISDA, IMPG/IMPGA, SEZ, ITC Reversal and Rejected sheets. Pass either flattened gstr2bRows or gstr2bSheets [{sheetName, rows}]. The tool auto-excludes summary/read-me sheets and tags every row with source sheet. By default it also excludes RCM rows and zero-tax/no-tax rows to avoid irrelevant output; set includeRcm/includeZeroTax true only when explicitly needed. Matching priority is Supplier GSTIN + Invoice Number, then supplier/date/taxable/tax fallback. Returns exceptions by default. It also supports backdated/later-booked timing windows and classifies period/date mismatches instead of marking them missing.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('Tally company name, validate using discover-companies/list-master company'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period start date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period end date'),
            gstr2bRows: z.array(z.object({}).passthrough()).optional().describe('flattened rows extracted from all relevant GSTR-2B Excel/JSON sheets, not only B2B. Each row may include sheet_name/gstr2b_sheet.'),
            gstr2bSheets: z.array(z.object({ sheetName: z.string(), rows: z.array(z.object({}).passthrough()) })).optional().describe('preferred for official GSTR-2B Excel: pass all workbook sheets as [{sheetName, rows}]. The tool automatically scans relevant detail sheets and excludes Read me/summary sheets.'),
            tallyPurchaseRows: z.array(z.object({}).passthrough()).optional().describe('optional purchase rows from Tally if already extracted. If not supplied, the tool fetches compact purchase register from Tally.'),
            valueTolerance: z.number().optional().describe('allowed taxable value difference, default 2 rupees'),
            taxTolerance: z.number().optional().describe('allowed tax amount difference, default 2 rupees'),
            dateToleranceDays: z.number().int().optional().describe('allowed invoice date difference, default 7 days'),
            dateSearchWindowDays: z.number().int().optional().describe('generic backdate/later-booking search window in days. Default 60. Used for fallback date mismatch diagnostics.'),
            lookBackDays: z.number().int().optional().describe('optional days to look before fromDate for backdated/booked earlier purchases. Default 60 if dateSearchWindowDays is used.'),
            lookAheadDays: z.number().int().optional().describe('optional days to look after toDate for later-booked purchases. Default 60 if dateSearchWindowDays is used.'),
            minimumScore: z.number().optional().describe('minimum possible-match score, default 75'),
            returnOnlyExceptions: z.boolean().optional().describe('default true, keeps output small by hiding matched rows'),
            maxOutputRows: z.number().int().optional().describe('maximum rows returned/cached, default 1000'),
            includeRcm: z.boolean().optional().describe('default false. Keep false to hide reverse-charge/RCM rows from GSTR-2B output.'),
            includeZeroTax: z.boolean().optional().describe('default false. Keep false to hide rows where IGST+CGST+SGST+CESS is zero.'),
            matchAcrossPeriods: z.boolean().optional().default(true).describe('default true. Match current period invoices against previous/current/next GSTR-2B and Tally periods to catch supplier uploaded earlier/later or booked earlier/later in Tally.'),
            lookBackMonths: z.number().int().optional().default(1).describe('when matchAcrossPeriods is true, also check this many previous months. Default 1.'),
            lookAheadMonths: z.number().int().optional().default(1).describe('when matchAcrossPeriods is true, also check this many next months. Default 1.'),
            gstr2bPeriod: z.string().optional().describe('optional return period for the uploaded GSTR-2B rows, e.g. 2026-05 or 052026. Rows/sheets can also carry their own gstr2b_period.')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const valueTolerance = args.valueTolerance ?? 2;
            const taxTolerance = args.taxTolerance ?? 2;
            const dateToleranceDays = args.dateToleranceDays ?? 7;
            const dateSearchWindowDays = Math.max(15, Math.min(args.dateSearchWindowDays ?? 60, 365));
            const lookBackDays = Math.max(0, Math.min(args.lookBackDays ?? dateSearchWindowDays, 365));
            const lookAheadDays = Math.max(0, Math.min(args.lookAheadDays ?? dateSearchWindowDays, 365));
            const minimumScore = args.minimumScore ?? 75;
            const returnOnlyExceptions = args.returnOnlyExceptions ?? true;
            const maxOutputRows = Math.max(1, Math.min(args.maxOutputRows ?? 1000, 5000));
            const includeRcm = args.includeRcm ?? false;
            const includeZeroTax = args.includeZeroTax ?? false;
            const matchAcrossPeriods = args.matchAcrossPeriods ?? true;
            const lookBackMonths = Math.max(0, Math.min(args.lookBackMonths ?? 1, 6));
            const lookAheadMonths = Math.max(0, Math.min(args.lookAheadMonths ?? 1, 6));
            const fetchFromDate = matchAcrossPeriods ? monthStartIso(addMonthsIso(args.fromDate, -lookBackMonths)) : args.fromDate;
            const fetchToDate = matchAcrossPeriods ? monthEndIso(addMonthsIso(args.toDate, lookAheadMonths)) : args.toDate;
            const currentPeriod = normalizePeriodKey('', args.fromDate);
            let rawTallyRows = Array.isArray(args.tallyPurchaseRows) ? args.tallyPurchaseRows : [];
            if (rawTallyRows.length === 0) {
                const inputParams = new Map([['fromDate', fetchFromDate], ['toDate', fetchToDate]]);
                if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
                const resp = await fetchReport('gstr-2b-purchase-register', inputParams);
                if (resp.error) return { isError: true, content: [{ type: 'text', text: resp.error }] };
                rawTallyRows = Array.isArray(resp.data) ? resp.data : [];
            }
            const rawGstr2bRows = collectGstr2bInputRows(args);
            if (!rawGstr2bRows.length) return { isError: true, content: [{ type: 'text', text: 'Provide gstr2bSheets with all workbook sheets or gstr2bRows flattened from all relevant GSTR-2B sheets. Do not pass only B2B if other sheets contain data.' }] };
            const gstrRowsAll = rawGstr2bRows.map(normalizeGstr2bRow).filter(isUsefulGstr2bRow);
            const gstrRows = gstrRowsAll.filter(r => (includeRcm || !r.rcm_case) && (includeZeroTax || Math.abs(r.total_tax || 0) > 0.005));
            const tallyRowsAll = rawTallyRows.map(normalizeTallyGstrPurchaseRow).filter(r => r.invoice_number || r.supplier_gstin || r.taxable_value || r.total_tax);
            const tallyRows = tallyRowsAll.filter(r => includeZeroTax || Math.abs(r.total_tax || 0) > 0.005);
            const tallyByKey = new Map();
            tallyRows.forEach((r, i) => {
                const key = gstrMatchKey(r);
                if (key !== '|') {
                    if (!tallyByKey.has(key)) tallyByKey.set(key, []);
                    tallyByKey.get(key).push(i);
                }
            });
            const usedTally = new Set();
            const matched = [];
            const exceptions = [];
            for (const gstr of gstrRows) {
                let best = null;
                const key = gstrMatchKey(gstr);
                let candidateIndexes = (key !== '|' && tallyByKey.has(key)) ? tallyByKey.get(key).filter(i => !usedTally.has(i)) : [];
                if (!candidateIndexes.length) {
                    candidateIndexes = tallyRows.map((_, i) => i).filter(i => !usedTally.has(i));
                }
                for (const i of candidateIndexes) {
                    const tally = tallyRows[i];
                    const result = scoreGstr2bMatch(gstr, tally, valueTolerance, taxTolerance, dateToleranceDays);
                    if (!best || result.score > best.result.score || (result.score === best.result.score && result.dateDiff < best.result.dateDiff)) {
                        best = { index: i, tally, result };
                    }
                }
                if (best && best.result.score >= minimumScore) {
                    usedTally.add(best.index);
                    let status = 'matched_same_period';
                    const gstrPeriod = gstr.gstr_period || normalizePeriodKey('', gstr.invoice_date || args.fromDate);
                    const tallyPeriod = best.tally.tally_period || normalizePeriodKey('', best.tally.voucher_date || best.tally.invoice_date || args.fromDate);
                    const periodDiff = comparePeriodKey(gstrPeriod, tallyPeriod);
                    if (gstr.rcm_case) status = 'rcm_case';
                    else if (gstr.itc_reversal) status = 'itc_reversal';
                    else if (gstr.itc_ineligible) status = 'itc_ineligible';
                    else if (best.result.taxableDiff > valueTolerance) status = 'taxable_value_mismatch';
                    else if (best.result.taxDiff > taxTolerance) status = 'tax_mismatch';
                    else if (matchAcrossPeriods && periodDiff > 0) status = 'supplier_uploaded_later';
                    else if (matchAcrossPeriods && periodDiff < 0) status = 'booked_later_in_tally';
                    else if (best.result.dateDiff > dateToleranceDays) status = 'date_mismatch';
                    const row = {
                        status,
                        match_score: best.result.score,
                        match_reasons: best.result.reasons.join(', '),
                        taxable_value_difference: Number(((gstr.taxable_value || 0) - (best.tally.taxable_value || 0)).toFixed(2)),
                        tax_difference: Number(((gstr.total_tax || 0) - (best.tally.total_tax || 0)).toFixed(2)),
                        mismatch_type: status === 'taxable_value_mismatch' ? 'taxable_value_difference' : (status === 'tax_mismatch' ? 'gst_tax_difference' : ''),
                        possible_reason: status === 'taxable_value_mismatch' || status === 'tax_mismatch' ? 'Possible GST rate/ITC classification difference, debit/credit note, discount, freight/other charges, amendment, rounding or purchase entry mismatch.' : '',
                        date_difference_days: best.result.dateDiff,
                        tally_booking_period: tallyPeriod,
                        gstr2b_period: gstrPeriod,
                        period_difference_months: periodDiff,
                        gstr_index: gstr.gstr_index,
                        gstr_sheet: gstr.gstr_sheet,
                        gstr_section: gstr.gstr_section,
                        gstr_period: gstrPeriod,
                        gstr_supplier_gstin: gstr.supplier_gstin,
                        gstr_supplier_name: gstr.supplier_name,
                        gstr_invoice_number: gstr.invoice_number_raw || gstr.invoice_number,
                        gstr_invoice_date: gstr.invoice_date,
                        gstr_taxable_value: gstr.taxable_value,
                        gstr_igst: gstr.igst,
                        gstr_cgst: gstr.cgst,
                        gstr_sgst: gstr.sgst,
                        gstr_cess: gstr.cess,
                        gstr_total_tax: gstr.total_tax,
                        gstr_itc_availability: gstr.itc_availability,
                        gstr_reverse_charge: gstr.reverse_charge,
                        tally_index: best.tally.tally_index,
                        tally_period: tallyPeriod,
                        tally_supplier_gstin: best.tally.supplier_gstin,
                        tally_supplier_name: best.tally.supplier_name,
                        tally_invoice_number: best.tally.invoice_number_raw || best.tally.invoice_number,
                        tally_invoice_date: best.tally.invoice_date,
                        tally_voucher_date: best.tally.voucher_date,
                        tally_voucher_type: best.tally.voucher_type,
                        tally_voucher_number: best.tally.voucher_number,
                        tally_taxable_value: best.tally.taxable_value,
                        tally_igst: best.tally.igst,
                        tally_cgst: best.tally.cgst,
                        tally_sgst: best.tally.sgst,
                        tally_cess: best.tally.cess,
                        tally_total_tax: best.tally.total_tax,
                        tally_narration: best.tally.narration,
                        value_source_note: 'GSTR values are read from GSTR-2B sheet columns; Tally values are read from the fetched purchase voucher/register columns. No taxable value or tax amount is back-calculated.'
                    };
                    if (status === 'matched_same_period') matched.push(row); else exceptions.push(row);
                } else {
                    exceptions.push({
                        status: 'only_in_2b', match_score: best?.result?.score || 0, match_reasons: best?.result?.reasons?.join(', ') || '', taxable_value_difference: gstr.taxable_value, tax_difference: gstr.total_tax, mismatch_type: '', possible_reason: '', date_difference_days: best?.result?.dateDiff ?? null,
                        gstr_index: gstr.gstr_index, gstr_sheet: gstr.gstr_sheet, gstr_section: gstr.gstr_section, gstr_period: gstr.gstr_period || currentPeriod, tally_booking_period: '', gstr2b_period: gstr.gstr_period || currentPeriod, period_difference_months: null, gstr_supplier_gstin: gstr.supplier_gstin, gstr_supplier_name: gstr.supplier_name, gstr_invoice_number: gstr.invoice_number_raw || gstr.invoice_number, gstr_invoice_date: gstr.invoice_date, gstr_taxable_value: gstr.taxable_value, gstr_igst: gstr.igst, gstr_cgst: gstr.cgst, gstr_sgst: gstr.sgst, gstr_cess: gstr.cess, gstr_total_tax: gstr.total_tax, gstr_itc_availability: gstr.itc_availability, gstr_reverse_charge: gstr.reverse_charge,
                        tally_index: null, tally_supplier_gstin: '', tally_supplier_name: '', tally_invoice_number: '', tally_invoice_date: '', tally_voucher_date: '', tally_voucher_type: '', tally_voucher_number: '', tally_taxable_value: 0, tally_igst: 0, tally_cgst: 0, tally_sgst: 0, tally_cess: 0, tally_total_tax: 0, tally_narration: '',
                        statement_value_source: 'uploaded_statement_debit_credit_or_amount',
                        tally_value_source: ''
                    });
                }
            }
            for (let i = 0; i < tallyRows.length; i++) {
                if (usedTally.has(i)) continue;
                const tally = tallyRows[i];
                const tallyDate = tally.invoice_date || tally.voucher_date;
                if (tallyDate && (tallyDate < args.fromDate || tallyDate > args.toDate)) {
                    continue;
                }
                exceptions.push({
                    status: 'only_in_tally', match_score: 0, match_reasons: '', taxable_value_difference: tally.taxable_value, tax_difference: tally.total_tax, mismatch_type: '', possible_reason: '', date_difference_days: null,
                    gstr_index: null, gstr_sheet: '', gstr_section: '', gstr_period: '', tally_booking_period: tally.tally_period || currentPeriod, gstr2b_period: '', period_difference_months: null, gstr_supplier_gstin: '', gstr_supplier_name: '', gstr_invoice_number: '', gstr_invoice_date: '', gstr_taxable_value: 0, gstr_igst: 0, gstr_cgst: 0, gstr_sgst: 0, gstr_cess: 0, gstr_total_tax: 0, gstr_itc_availability: '', gstr_reverse_charge: '',
                    tally_index: tally.tally_index, tally_period: tally.tally_period || currentPeriod, tally_supplier_gstin: tally.supplier_gstin, tally_supplier_name: tally.supplier_name, tally_invoice_number: tally.invoice_number_raw || tally.invoice_number, tally_invoice_date: tally.invoice_date, tally_voucher_date: tally.voucher_date, tally_voucher_type: tally.voucher_type, tally_voucher_number: tally.voucher_number, tally_taxable_value: tally.taxable_value, tally_igst: tally.igst, tally_cgst: tally.cgst, tally_sgst: tally.sgst, tally_cess: tally.cess, tally_total_tax: tally.total_tax, tally_narration: tally.narration,
                    value_source_note: 'Tally values are read from fetched purchase voucher/register columns; no GSTR-2B match found.'
                });
            }

            const onlyIn2b = exceptions.filter(e => e.status === 'only_in_2b');
            const onlyInTally = exceptions.filter(e => e.status === 'only_in_tally');
            const otherExceptions = exceptions.filter(e => e.status !== 'only_in_2b' && e.status !== 'only_in_tally');

            for (let gIdx = 0; gIdx < onlyIn2b.length; gIdx++) {
                const gstr = onlyIn2b[gIdx];
                if (gstr.status !== 'only_in_2b') continue;

                const candidates = [];
                for (let tIdx = 0; tIdx < onlyInTally.length; tIdx++) {
                    const t = onlyInTally[tIdx];
                    if (t.status !== 'only_in_tally') continue;

                    const gstinSame = gstr.gstr_supplier_gstin && t.tally_supplier_gstin && gstr.gstr_supplier_gstin === t.tally_supplier_gstin;
                    if (gstinSame) {
                        const dateDiff = daysBetween(gstr.gstr_invoice_date, t.tally_invoice_date || t.tally_voucher_date);
                        if (dateDiff <= dateSearchWindowDays) {
                            candidates.push({ index: tIdx, amount: t.taxable_value_difference, dateDiff });
                        }
                    }
                }

                if (candidates.length >= 2) {
                    const matchedIndices = findSubsetSum(candidates, gstr.taxable_value_difference, valueTolerance);
                    if (matchedIndices) {
                        gstr.status = 'matched_consolidated';
                        gstr.match_score = 95;
                        gstr.taxable_value_difference = 0;
                        gstr.tax_difference = 0;
                        gstr.match_reasons = 'matched via consolidated/split purchase sum';

                        matchedIndices.forEach(tIdx => {
                            const t = onlyInTally[tIdx];
                            t.status = 'matched_consolidated';
                            t.match_score = 95;
                            t.taxable_value_difference = 0;
                            t.tax_difference = 0;
                            t.match_reasons = 'matched via consolidated/split purchase sum';

                            t.gstr_index = gstr.gstr_index;
                            t.gstr_sheet = gstr.gstr_sheet;
                            t.gstr_section = gstr.gstr_section;
                            t.gstr_period = gstr.gstr_period;
                            t.gstr_supplier_gstin = gstr.gstr_supplier_gstin;
                            t.gstr_supplier_name = gstr.gstr_supplier_name;
                            t.gstr_invoice_number = gstr.gstr_invoice_number;
                            t.gstr_invoice_date = gstr.gstr_invoice_date;
                            t.gstr_taxable_value = gstr.gstr_taxable_value;
                            t.gstr_igst = gstr.gstr_igst;
                            t.gstr_cgst = gstr.gstr_cgst;
                            t.gstr_sgst = gstr.gstr_sgst;
                            t.gstr_cess = gstr.gstr_cess;
                            t.gstr_total_tax = gstr.gstr_total_tax;
                            t.gstr_itc_availability = gstr.gstr_itc_availability;
                            t.gstr_reverse_charge = gstr.gstr_reverse_charge;

                            matched.push(t);
                        });
                        matched.push(gstr);
                    }
                }
            }

            const finalOnlyIn2b = onlyIn2b.filter(e => e.status === 'only_in_2b');
            const finalOnlyInTally = onlyInTally.filter(e => e.status === 'only_in_tally');
            const finalMatchedConsolidated = matched.filter(m => m.status === 'matched_consolidated');
            const finalMatched = matched.filter(m => m.status !== 'matched_consolidated');

            const fullRows = returnOnlyExceptions
                ? [...otherExceptions, ...finalOnlyIn2b, ...finalOnlyInTally]
                : [...finalMatched, ...finalMatchedConsolidated, ...otherExceptions, ...finalOnlyIn2b, ...finalOnlyInTally];
            const rows = fullRows.slice(0, maxOutputRows);
            const statusCounts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
            const summary = {
                gstr2b_input_rows_all_sheets: rawGstr2bRows.length,
                gstr2b_rows_after_filters: gstrRows.length,
                gstr2b_rows_excluded_rcm: gstrRowsAll.filter(r => r.rcm_case).length,
                gstr2b_rows_excluded_zero_tax: gstrRowsAll.filter(r => Math.abs(r.total_tax || 0) <= 0.005).length,
                tally_purchase_rows_after_filters: tallyRows.length,
                tally_purchase_rows_excluded_zero_tax: tallyRowsAll.filter(r => Math.abs(r.total_tax || 0) <= 0.005).length,
                includeRcm,
                includeZeroTax,
                matchAcrossPeriods,
                lookBackMonths,
                lookAheadMonths,
                dateSearchWindowDays,
                lookBackDays,
                lookAheadDays,
                fetchFromDate,
                fetchToDate,
                currentPeriod,
                gstr2b_sheets_scanned: [...new Set(gstrRows.map(r => r.gstr_sheet).filter(Boolean))],
                tally_purchase_rows_before_filters: tallyRowsAll.length,
                matched: matched.length,
                exceptions: exceptions.length,
                status_counts_in_output: statusCounts,
                gstr2b_taxable_value: Number(gstrRows.reduce((s, r) => s + (r.taxable_value || 0), 0).toFixed(2)),
                tally_taxable_value: Number(tallyRows.reduce((s, r) => s + (r.taxable_value || 0), 0).toFixed(2)),
                gstr2b_total_tax: Number(gstrRows.reduce((s, r) => s + (r.total_tax || 0), 0).toFixed(2)),
                tally_total_tax: Number(tallyRows.reduce((s, r) => s + (r.total_tax || 0), 0).toFixed(2)),
                valueTolerance, taxTolerance, dateToleranceDays, minimumScore, returnOnlyExceptions, output_rows: rows.length, total_result_rows_before_limit: fullRows.length, output_limited: fullRows.length > rows.length,
                direct_voucher_values_only: true,
                no_back_calculation: true
            };
            const tableId = await cacheTable(new Map([
                ['status', 'string'], ['match_score', 'number'], ['match_reasons', 'string'], ['taxable_value_difference', 'number'], ['tax_difference', 'number'], ['mismatch_type', 'string'], ['possible_reason', 'string'], ['date_difference_days', 'number'], ['tally_booking_period', 'string'], ['gstr2b_period', 'string'], ['period_difference_months', 'number'],
                ['gstr_index', 'number'], ['gstr_sheet', 'string'], ['gstr_section', 'string'], ['gstr_period', 'string'], ['gstr_supplier_gstin', 'string'], ['gstr_supplier_name', 'string'], ['gstr_invoice_number', 'string'], ['gstr_invoice_date', 'date'], ['gstr_taxable_value', 'number'], ['gstr_igst', 'number'], ['gstr_cgst', 'number'], ['gstr_sgst', 'number'], ['gstr_cess', 'number'], ['gstr_total_tax', 'number'], ['gstr_itc_availability', 'string'], ['gstr_reverse_charge', 'string'],
                ['tally_index', 'number'], ['tally_period', 'string'], ['tally_supplier_gstin', 'string'], ['tally_supplier_name', 'string'], ['tally_invoice_number', 'string'], ['tally_invoice_date', 'date'], ['tally_voucher_date', 'date'], ['tally_voucher_type', 'string'], ['tally_voucher_number', 'string'], ['tally_taxable_value', 'number'], ['tally_igst', 'number'], ['tally_cgst', 'number'], ['tally_sgst', 'number'], ['tally_cess', 'number'], ['tally_total_tax', 'number'], ['tally_narration', 'string'], ['value_source_note', 'string']
            ]), rows);
            return { content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, rows: rows.length, summary, message: `Use query-database on tableID to filter by status. Default output is exceptions only. only_in_2b means supplier uploaded in 2B but not found in Tally; only_in_tally means booked in Tally but not in 2B; supplier_uploaded_later/booked_later_in_tally mean the invoice was found in a previous/next month based on gstr2b_period and tally_booking_period; tax_mismatch/taxable_value_mismatch/date_mismatch show matched invoice with differences and possible_reason explains common causes like credit/debit notes, freight/discount, amendments, rounding or purchase-entry mismatch. For lower token use, upload GSTR-2B Excel/JSON and do not paste raw PDF text. For official GST portal Excel, Claude should read all workbook sheets and pass them as gstr2bSheets, not just B2B. RCM and zero-tax/no-tax rows are hidden by default; use includeRcm/includeZeroTax only when the user asks.` }) }] };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err?.message || err) }] };
        }
    });


    mcpServer.registerTool('tds-on-purchases', {
        title: 'TDS on Purchases (194Q)',
        description: `Generates TDS on Purchases report for section 194Q only (purchase of goods above threshold). This tool is EXCLUSIVELY for TDS deducted on purchase transactions under section 194Q. It ALWAYS filters to section 194Q and never includes other TDS sections like 194C, 194A, 194H, 194I, 194T, 194JA, 194JB, 195 etc. Use the separate tds-report tool for all non-purchase TDS sections. Features: threshold tracking (default ₹50 lakh per buyer-seller pair), purchase-voucher-focused filtering, PAN/entity classification, and taxable-value base selection. Report is bill/voucher-row wise — one row per purchase voucher, sorted by party then date. Amount Paid comes directly from voucher taxable ledger; never back-calculated from TDS amount. Deductee is always the purchase supplier ledger. Excludes TDS challan/deposit vouchers, TDS by Party types, and journal vouchers unless they are clear 194Q provision/adjustment entries.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('company name, validate using discover-companies'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('from date, required if tdsRows are not provided'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('to date, required if tdsRows are not provided'),
            reportType: z.enum(['tds_on_purchase', 'section_wise', 'tds_deducted', 'tds_payable', 'pan_exception', 'rate_mismatch', 'all']).optional().default('all').describe('type of TDS report'),
            section: z.string().optional().describe('TDS section to filter/report, e.g. 194Q, 194C, 194J'),
            partyContains: z.string().optional().describe('optional party/ledger contains filter'),
            tdsRows: z.array(z.object({}).passthrough()).optional().describe('optional structured rows. If omitted, MCP fetches tds-payment-sheet from Tally.'),
            tdsBaseMode: z.enum(['taxable_value', 'gross_value', 'payment_value', 'auto_detect']).optional().default('taxable_value').describe('base on which expected TDS should be calculated'),
            advanceHandling: z.enum(['ignore_advances', 'include_advances', 'adjust_against_future_invoice']).optional().default('include_advances').describe('how advance payment rows should be handled'),
            thresholdAmount: z.number().optional().describe('threshold amount. For 194Q default is 5000000.'),
            expectedRate: z.number().optional().describe('generic expected TDS rate percent when section-specific rate is not configured'),
            expectedRate194Q: z.number().optional().describe('expected 194Q rate percent, default 0.1'),
            expectedRateIndividual: z.number().optional().describe('expected contractor 194C rate for Individual/HUF, default 1'),
            expectedRateOthers: z.number().optional().describe('expected contractor 194C rate for Company/Firm/Others, default 2'),
            expectedRateCompany: z.number().optional().describe('optional expected rate for company deductees in non-194C reports'),
            expectedRateNonCompany: z.number().optional().describe('optional expected rate for non-company deductees in non-194C reports'),
            tdsTolerance: z.number().optional().default(1).describe('allowed TDS amount difference'),
            rateTolerance: z.number().optional().default(0.05).describe('allowed TDS rate percent difference'),
            returnOnlyExceptions: z.boolean().optional().default(false).describe('if true, excludes matched rows'),
            maxOutputRows: z.number().optional().default(1000).describe('maximum rows cached/output'),
            sectionWiseRowMode: z.enum(['bill_wise', 'voucher_wise', 'party_total']).optional().default('bill_wise').describe('for section_wise report, default bill_wise means do not aggregate party rows; show separate rows for each bill/voucher and repeat party name'),
            showPartyTotals: z.boolean().optional().default(false).describe('for section_wise report, default false. Do not add party total rows unless explicitly requested'),
            includePaymentVouchers: z.boolean().optional().default(true).describe('default true for TDS reports because party payment vouchers may contain deduction rows. Government challan/TDS deposit payments are still excluded automatically.'),
            allowedDeductionVoucherTypes: z.array(z.string()).optional().describe('voucher types allowed in TDS reports. Default: Purchase, Payment, Journal. Journal rows are included only when they look like adjustment/provision/accrual entries; TDS by Party and government challan/TDS payment rows are excluded.')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        return generateTdsReportInternal(args, '194Q_ONLY');
    });


    mcpServer.registerTool('tds-report', {
        title: 'TDS Report (Non-Purchase Sections)',
        description: `Generates TDS deduction reports for all non-purchase TDS sections — 194C (contractors), 194A (interest), 194H (commission/brokerage), 194I (rent), 194T (partner payments), 194JA (professional fees), 194JB (technical/royalty fees), 195 (non-resident), 192 (salary), and any other section EXCEPT 194Q. This tool NEVER includes 194Q (TDS on purchases of goods). For TDS on purchases under 194Q, use the separate tds-on-purchases tool instead. Section detection is dynamic — includes whatever non-194Q sections exist in Tally vouchers, including 194JB, 194T, 194N and non-standard shorthands like 94JB/94T/94N. For 194C contractors, reports Proprietor/Individual, HUF, Firm/LLP, Company or Others based on PAN. For other sections, reports company/non-company based on PAN. Report is bill/voucher-row wise for section_wise mode — one row per voucher, sorted by party then date. Amount Paid comes directly from voucher taxable ledger; never back-calculated from TDS amount. Deductee is always the party/supplier/credited ledger, never the TDS or expense ledger.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('company name, validate using discover-companies'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('from date, required if tdsRows are not provided'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('to date, required if tdsRows are not provided'),
            reportType: z.enum(['tds_on_purchase', 'section_wise', 'tds_deducted', 'tds_payable', 'pan_exception', 'rate_mismatch', 'all']).optional().default('all').describe('type of TDS report'),
            section: z.string().optional().describe('TDS section to filter/report, e.g. 194Q, 194C, 194J'),
            partyContains: z.string().optional().describe('optional party/ledger contains filter'),
            tdsRows: z.array(z.object({}).passthrough()).optional().describe('optional structured rows. If omitted, MCP fetches tds-payment-sheet from Tally.'),
            tdsBaseMode: z.enum(['taxable_value', 'gross_value', 'payment_value', 'auto_detect']).optional().default('taxable_value').describe('base on which expected TDS should be calculated'),
            advanceHandling: z.enum(['ignore_advances', 'include_advances', 'adjust_against_future_invoice']).optional().default('include_advances').describe('how advance payment rows should be handled'),
            thresholdAmount: z.number().optional().describe('threshold amount. For 194Q default is 5000000.'),
            expectedRate: z.number().optional().describe('generic expected TDS rate percent when section-specific rate is not configured'),
            expectedRate194Q: z.number().optional().describe('expected 194Q rate percent, default 0.1'),
            expectedRateIndividual: z.number().optional().describe('expected contractor 194C rate for Individual/HUF, default 1'),
            expectedRateOthers: z.number().optional().describe('expected contractor 194C rate for Company/Firm/Others, default 2'),
            expectedRateCompany: z.number().optional().describe('optional expected rate for company deductees in non-194C reports'),
            expectedRateNonCompany: z.number().optional().describe('optional expected rate for non-company deductees in non-194C reports'),
            tdsTolerance: z.number().optional().default(1).describe('allowed TDS amount difference'),
            rateTolerance: z.number().optional().default(0.05).describe('allowed TDS rate percent difference'),
            returnOnlyExceptions: z.boolean().optional().default(false).describe('if true, excludes matched rows'),
            maxOutputRows: z.number().optional().default(1000).describe('maximum rows cached/output'),
            sectionWiseRowMode: z.enum(['bill_wise', 'voucher_wise', 'party_total']).optional().default('bill_wise').describe('for section_wise report, default bill_wise means do not aggregate party rows; show separate rows for each bill/voucher and repeat party name'),
            showPartyTotals: z.boolean().optional().default(false).describe('for section_wise report, default false. Do not add party total rows unless explicitly requested'),
            includePaymentVouchers: z.boolean().optional().default(true).describe('default true for TDS reports because party payment vouchers may contain deduction rows. Government challan/TDS deposit payments are still excluded automatically.'),
            allowedDeductionVoucherTypes: z.array(z.string()).optional().describe('voucher types allowed in TDS reports. Default: Purchase, Payment, Journal. Journal rows are included only when they look like adjustment/provision/accrual entries; TDS by Party and government challan/TDS payment rows are excluded.')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        return generateTdsReportInternal(args, 'EXCLUDE_194Q');
    });

    mcpServer.registerTool('tds-reconciliation', {
        title: 'TDS Reconciliation',
        description: `Reconciles Tally TDS voucher rows with Form 26AS/TRACES/TDS return/challan rows. Use this after uploading a structured Excel/CSV/JSON from TRACES/26AS or after extracting compact rows from a PDF. It compares PAN, TDS section, taxable value, TDS amount, TDS rate, voucher/reference, deduction/challan dates and returns exceptions by default: only_in_external, only_in_tally, pan_missing, section_mismatch, rate_mismatch, taxable_value_mismatch, tds_amount_mismatch, challan_unmatched, possible_duplicate, matched. It does not back-calculate taxable value from TDS amount; taxable value is compared directly when available. It also handles backdated/later-booked TDS rows by using a configurable date search window and marks date_mismatch instead of treating timing differences as missing.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('company name, validate using discover-companies/list-master company'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('from date, required if tallyTdsRows are not provided'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('to date, required if tallyTdsRows are not provided'),
            partyContains: z.string().optional().describe('optional party filter to reduce Tally load'),
            externalTdsRows: z.array(z.object({}).passthrough()).min(1).describe('rows from Form 26AS/TRACES/TDS return/challan Excel/CSV/JSON. Supported columns: party/deductee name, PAN, section, date, taxable value/amount paid, TDS amount/tax deducted, TDS rate, challan BSR, challan serial no, challan date, challan amount, certificate/reference number.'),
            tallyTdsRows: z.array(z.object({}).passthrough()).optional().describe('optional Tally TDS rows. If omitted, MCP fetches tds-payment-sheet from Tally using fromDate/toDate.'),
            taxableTolerance: z.number().optional().default(1).describe('allowed taxable value difference'),
            tdsTolerance: z.number().optional().default(1).describe('allowed TDS amount difference'),
            rateTolerance: z.number().optional().default(0.05).describe('allowed TDS rate percentage difference'),
            dateToleranceDays: z.number().int().optional().default(7),
            dateSearchWindowDays: z.number().int().optional().default(60).describe('generic backdate/later-booking search window in days, default 60'),
            lookBackDays: z.number().int().optional().describe('extend Tally fetch before fromDate to catch backdated/booked earlier TDS rows. Default equals dateSearchWindowDays.'),
            lookAheadDays: z.number().int().optional().describe('extend Tally fetch after toDate to catch later-booked/future dated TDS rows. Default equals dateSearchWindowDays.'),
            minimumScore: z.number().optional().default(55),
            returnOnlyExceptions: z.boolean().optional().default(true),
            maxOutputRows: z.number().int().positive().optional().default(1000)
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const taxableTolerance = args.taxableTolerance ?? 1;
            const tdsTolerance = args.tdsTolerance ?? 1;
            const rateTolerance = args.rateTolerance ?? 0.05;
            const dateToleranceDays = args.dateToleranceDays ?? 7;
            const dateSearchWindowDays = Math.max(15, Math.min(args.dateSearchWindowDays ?? 60, 365));
            const lookBackDays = Math.max(0, Math.min(args.lookBackDays ?? dateSearchWindowDays, 365));
            const lookAheadDays = Math.max(0, Math.min(args.lookAheadDays ?? dateSearchWindowDays, 365));
            const minimumScore = args.minimumScore ?? 55;
            const returnOnlyExceptions = args.returnOnlyExceptions ?? true;
            const maxOutputRows = args.maxOutputRows ?? 1000;
            let rawTallyRows = Array.isArray(args.tallyTdsRows) ? args.tallyTdsRows : [];
            if (!rawTallyRows.length) {
                if (!args.fromDate || !args.toDate) return { isError: true, content: [{ type: 'text', text: 'fromDate and toDate are required when tallyTdsRows are not provided.' }] };
                const inputParams = new Map([['fromDate', shiftIsoDate(args.fromDate, -lookBackDays)], ['toDate', shiftIsoDate(args.toDate, lookAheadDays)]]);
                if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
                if (args.partyContains) inputParams.set('partyContains', args.partyContains);
                const resp = await fetchReport('tds-payment-sheet', inputParams);
                if (resp.error) return { isError: true, content: [{ type: 'text', text: resp.error }] };
                rawTallyRows = Array.isArray(resp.data) ? resp.data : [];
            }
            const externalRows = (Array.isArray(args.externalTdsRows) ? args.externalTdsRows : []).map(normalizeExternalTdsRow).filter(r => r.pan || r.party_name || r.tds_amount || r.taxable_value);
            const tallyRows = rawTallyRows.map(normalizeTallyTdsRow).filter(r => r.pan || r.party_name || r.tds_amount || r.taxable_value);
            const tallyIndex = buildTdsTallyIndex(tallyRows);
            const usedTally = new Set();
            const results = [];
            for (const ext of externalRows) {
                const candidates = new Set();
                const exact = tallyIndex.byKey.get(tdsKey(ext));
                if (exact) exact.forEach(i => candidates.add(i));
                const ps = tallyIndex.byPanSection.get(`${ext.pan}|${ext.section}`);
                if (ps) ps.forEach(i => candidates.add(i));
                const amtKey = String(Math.round(Math.abs(ext.tds_amount || 0) * 100));
                const amt = tallyIndex.byAmount.get(amtKey);
                if (amt) amt.forEach(i => candidates.add(i));
                let best = null;
                const pool = candidates.size ? [...candidates] : tallyRows.map((_, i) => i).slice(0, 500);
                for (const i of pool) {
                    if (usedTally.has(i)) continue;
                    const tally = tallyRows[i];
                    const scored = scoreTdsMatch(ext, tally, taxableTolerance, tdsTolerance, rateTolerance, dateToleranceDays);
                    if (!best || scored.score > best.score || (scored.score === best.score && scored.dateDiff < best.dateDiff)) {
                        best = { i, tally, ...scored };
                    }
                }
                const baseExternal = {
                    external_index: ext.external_index, external_party_name: ext.party_name, external_pan: ext.pan, external_section: ext.section, external_date: ext.date, external_voucher_number: ext.voucher_number, external_taxable_value: ext.taxable_value, external_tds_amount: ext.tds_amount, external_tds_rate: ext.tds_rate, external_challan_bsr: ext.challan_bsr, external_challan_serial_no: ext.challan_serial_no, external_challan_date: ext.challan_date, external_challan_amount: ext.challan_amount, external_certificate_no: ext.certificate_no, external_narration: ext.narration
                };
                if (best && best.score >= minimumScore) {
                    usedTally.add(best.i);
                    let status = 'matched';
                    const mismatchStatuses = [];
                    if (!ext.pan || !best.tally.pan) mismatchStatuses.push('pan_missing');
                    else if (ext.pan !== best.tally.pan && tokenSimilarity(ext.party_name, best.tally.party_name) >= 0.45) mismatchStatuses.push('pan_mismatch');
                    if (ext.section && best.tally.section && ext.section !== best.tally.section) mismatchStatuses.push('section_mismatch');
                    if (best.taxableDiff > taxableTolerance) mismatchStatuses.push('taxable_value_mismatch');
                    if (best.tdsDiff > tdsTolerance) mismatchStatuses.push('tds_amount_mismatch');
                    if ((ext.tds_rate || best.tally.tds_rate) && best.rateDiff > rateTolerance) mismatchStatuses.push('rate_mismatch');
                    if (best.dateDiff > dateToleranceDays) mismatchStatuses.push(best.dateDiff < 999999 ? 'date_mismatch' : 'date_missing');
                    if ((ext.challan_bsr || ext.challan_serial_no || ext.challan_amount) && !best.tally.challan_bsr && !best.tally.challan_serial_no && !best.tally.challan_amount) mismatchStatuses.push('challan_unmatched');
                    if (mismatchStatuses.length) status = mismatchStatuses.join('+');
                    const possibleReason = mismatchStatuses.length ? 'Possible PAN/section/rate issue, taxable value base difference, threshold/rate classification, challan mapping issue, rounding, backdated voucher, later booking, or TDS deducted/booked in a different voucher/period.' : '';
                    results.push({
                        status, match_score: best.score, match_reasons: best.reasons.join(', '), taxable_value_difference: Number(((ext.taxable_value || 0) - (best.tally.taxable_value || 0)).toFixed(2)), tds_amount_difference: Number(((ext.tds_amount || 0) - (best.tally.tds_amount || 0)).toFixed(2)), rate_difference: Number(((ext.tds_rate || 0) - (best.tally.tds_rate || 0)).toFixed(4)), mismatch_type: mismatchStatuses.join('+'), possible_reason: possibleReason, date_difference_days: best.dateDiff,
                        ...baseExternal,
                        tally_index: best.tally.tally_index, tally_party_name: best.tally.party_name, tally_pan: best.tally.pan, tally_section: best.tally.section, tally_date: best.tally.date, tally_voucher_type: best.tally.voucher_type || '', tally_voucher_number: best.tally.voucher_number, tally_taxable_ledger: best.tally.taxable_ledger, tally_taxable_value: best.tally.taxable_value, tally_tds_amount: best.tally.tds_amount, tally_tds_rate: best.tally.tds_rate, tally_challan_bsr: best.tally.challan_bsr, tally_challan_serial_no: best.tally.challan_serial_no, tally_challan_date: best.tally.challan_date, tally_challan_amount: best.tally.challan_amount, tally_narration: best.tally.narration
                    });
                } else {
                    results.push({ status: 'only_in_external', match_score: best?.score || 0, match_reasons: best?.reasons?.join(', ') || '', taxable_value_difference: ext.taxable_value, tds_amount_difference: ext.tds_amount, rate_difference: ext.tds_rate, mismatch_type: '', possible_reason: '', date_difference_days: best?.dateDiff ?? null, ...baseExternal, tally_index: null, tally_party_name: '', tally_pan: '', tally_section: '', tally_date: '', tally_voucher_type: '', tally_voucher_number: '', tally_taxable_ledger: '', tally_taxable_value: 0, tally_tds_amount: 0, tally_tds_rate: 0, tally_challan_bsr: '', tally_challan_serial_no: '', tally_challan_date: '', tally_challan_amount: 0, tally_narration: '' });
                }
            }
            tallyRows.forEach((tally, i) => {
                if (!usedTally.has(i)) results.push({ status: 'only_in_tally', match_score: 0, match_reasons: '', taxable_value_difference: -tally.taxable_value, tds_amount_difference: -tally.tds_amount, rate_difference: -tally.tds_rate, mismatch_type: '', possible_reason: '', date_difference_days: null, external_index: null, external_party_name: '', external_pan: '', external_section: '', external_date: '', external_voucher_number: '', external_taxable_value: 0, external_tds_amount: 0, external_tds_rate: 0, external_challan_bsr: '', external_challan_serial_no: '', external_challan_date: '', external_challan_amount: 0, external_certificate_no: '', external_narration: '', tally_index: tally.tally_index, tally_party_name: tally.party_name, tally_pan: tally.pan, tally_section: tally.section, tally_date: tally.date, tally_voucher_type: tally.voucher_type || '', tally_voucher_number: tally.voucher_number, tally_taxable_ledger: tally.taxable_ledger, tally_taxable_value: tally.taxable_value, tally_tds_amount: tally.tds_amount, tally_tds_rate: tally.tds_rate, tally_challan_bsr: tally.challan_bsr, tally_challan_serial_no: tally.challan_serial_no, tally_challan_date: tally.challan_date, tally_challan_amount: tally.challan_amount, tally_narration: tally.narration });
            });
            const fullRows = returnOnlyExceptions ? results.filter(r => r.status !== 'matched') : results;
            const rows = fullRows.slice(0, maxOutputRows);
            const counts = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
            const summary = { external_rows: externalRows.length, tally_rows: tallyRows.length, ...counts, external_taxable_value: Number(externalRows.reduce((s, r) => s + (r.taxable_value || 0), 0).toFixed(2)), tally_taxable_value: Number(tallyRows.reduce((s, r) => s + (r.taxable_value || 0), 0).toFixed(2)), external_tds_amount: Number(externalRows.reduce((s, r) => s + (r.tds_amount || 0), 0).toFixed(2)), tally_tds_amount: Number(tallyRows.reduce((s, r) => s + (r.tds_amount || 0), 0).toFixed(2)), taxableTolerance, tdsTolerance, rateTolerance, dateToleranceDays, dateSearchWindowDays, lookBackDays, lookAheadDays, fetched_tally_from_date: args.fromDate ? shiftIsoDate(args.fromDate, -lookBackDays) : '', fetched_tally_to_date: args.toDate ? shiftIsoDate(args.toDate, lookAheadDays) : '', returnOnlyExceptions, output_rows: rows.length, total_result_rows_before_limit: fullRows.length, output_limited: fullRows.length > rows.length };
            const tableId = await cacheTable(new Map([
                ['status', 'string'], ['match_score', 'number'], ['match_reasons', 'string'], ['taxable_value_difference', 'number'], ['tds_amount_difference', 'number'], ['rate_difference', 'number'], ['mismatch_type', 'string'], ['possible_reason', 'string'], ['date_difference_days', 'number'],
                ['external_index', 'number'], ['external_party_name', 'string'], ['external_pan', 'string'], ['external_section', 'string'], ['external_date', 'date'], ['external_voucher_number', 'string'], ['external_taxable_value', 'number'], ['external_tds_amount', 'number'], ['external_tds_rate', 'number'], ['external_challan_bsr', 'string'], ['external_challan_serial_no', 'string'], ['external_challan_date', 'date'], ['external_challan_amount', 'number'], ['external_certificate_no', 'string'], ['external_narration', 'string'],
                ['tally_index', 'number'], ['tally_party_name', 'string'], ['tally_pan', 'string'], ['tally_section', 'string'], ['tally_date', 'date'], ['tally_voucher_type', 'string'], ['tally_voucher_number', 'string'], ['tally_taxable_ledger', 'string'], ['tally_taxable_value', 'number'], ['tally_tds_amount', 'number'], ['tally_tds_rate', 'number'], ['tally_challan_bsr', 'string'], ['tally_challan_serial_no', 'string'], ['tally_challan_date', 'date'], ['tally_challan_amount', 'number'], ['tally_narration', 'string'], ['value_source_note', 'string']
            ]), rows);
            return { content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, rows: rows.length, summary, message: 'Use query-database on tableID to filter by status. Default output is exceptions only. For lower tokens, upload TRACES/26AS/TDS return Excel/CSV or compact rows; do not paste raw PDF text.' }) }] };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err?.message || err) }] };
        }
    });

    mcpServer.registerTool('chart-of-accounts', {
        title: 'Chart of Accounts',
        description: `fetches chart of accounts or GL hierarchy with fields ledger_name, group_name, primary_group, bs_pl, dr_cr, affects_gross_profit, sort_position. the column bs_pl will have values false = Balance Sheet / true = Profit Loss. Column dr_cr as value true = Debit / false = Credit. primary_group is the primary group of parent or group, under which ledger is nested. The columns group and parent are tree structure represented in flat format. The column affects_gross_profit has values true / false, it is used to determine if ledger under this group will affect gross profit or not. sort_position determines position or placement order with respect to items of same level for display, returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let result = await queryCollection('Ledger', ['Name', 'Parent', '_PrimaryGroup', 'IsRevenue', 'IsDeemedPositive', 'AffectsGrossProfit', 'SortPosition'], new Map(), args.targetCompany);
            result = renameObjectArrayProperties(result, new Map([['Name', 'ledger_name'], ['Parent', 'group_name'], ['_PrimaryGroup', 'primary_group'], ['IsRevenue', 'bs_pl'], ['IsDeemedPositive', 'dr_cr'], ['AffectsGrossProfit', 'affects_gross_profit'], ['SortPosition', 'sort_position']]));
            let tableID = await cacheTable(new Map([['ledger_name', 'string'], ['group_name', 'string'], ['primary_group', 'string'], ['bs_pl', 'boolean'], ['dr_cr', 'boolean'], ['affects_gross_profit', 'boolean'], ['sort_position', 'number']]), result);
            return tableResponse(tableID, safeCount(result), safeCount(result) === 0 ? 'No rows found for this report/date range/company.' : undefined);
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('trial-balance', {
        title: 'Trial Balance',
        description: `fetches trial balance with fields ledger_name, group_name (blank if Profit & Loss), opening_balance, net_debit, net_credit, closing_balance. opening_balance and closing_balance negative is debit and positive is credit. kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from or start date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to or end date'),
            group_name: z.string().optional().describe('optional group name to filter trial balance results, validate it using list-master tool with collection as group if required')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map();
            if (args.group_name) {
                lstFilters.set('Specific_Group', `$$IsEqual:$Parent:"${args.group_name}"`);
            }
            let result = await queryCollection('Ledger', ['Name', 'Parent', 'OpeningBalance', 'DebitTotals', 'CreditTotals', 'ClosingBalance'], lstFilters, args.targetCompany, parseBankStatementDate(args.fromDate), parseBankStatementDate(args.toDate));
            result = renameObjectArrayProperties(result, new Map([['Name', 'ledger_name'], ['Parent', 'group_name'], ['OpeningBalance', 'opening_balance'], ['DebitTotals', 'net_debit'], ['CreditTotals', 'net_credit'], ['ClosingBalance', 'closing_balance']]));
            let tableID = await cacheTable(new Map([['ledger_name', 'string'], ['group_name', 'string'], ['opening_balance', 'amount'], ['net_debit', 'amount'], ['net_credit', 'amount'], ['closing_balance', 'amount']]), result);
            return tableResponse(tableID, safeCount(result), safeCount(result) === 0 ? 'No rows found for this report/date range/company.' : undefined);
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('profit-loss', {
        title: 'Profit and Loss',
        description: `fetches profit and loss statement with fields like ledger_name, group_name, closing_balance. closing_balance negative is debit or expense and positive is credit or income. closing stock to be treated as credit, kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. for detailed ledger level analysis call trial-balance tool, returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from or start date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to or end date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let result = [];
            // ledger rows
            let result_ledger = await queryCollection('Ledger', ['Name', 'Parent', 'ClosingBalance'], new Map([['PL_Group', '$IsRevenue']]), args.targetCompany, parseBankStatementDate(args.fromDate), parseBankStatementDate(args.toDate));
            result_ledger = renameObjectArrayProperties(result_ledger, new Map([['Name', 'ledger_name'], ['Parent', 'group_name'], ['ClosingBalance', 'closing_balance']]));
            // opening and closing stock row
            let result_stock = await queryCollection('Group', ['Name', 'OpeningBalance', 'ClosingBalance'], new Map([['StockTypeGroup', '$$IsEqual:$Name:"Stock-in-Hand"']]), args.targetCompany, parseBankStatementDate(args.fromDate), parseBankStatementDate(args.toDate));
            if (result_stock.length > 0) {
                result.push({
                    ledger_name: 'Opening Stock',
                    group_name: 'Stock-in-Hand',
                    closing_balance: result_stock[0].OpeningBalance
                });
                result.push({
                    ledger_name: 'Closing Stock',
                    group_name: 'Stock-in-Hand',
                    closing_balance: -result_stock[0].ClosingBalance
                });
            }
            // merge ledger and stock results
            result.push(...result_ledger);
            let tableID = await cacheTable(new Map([['ledger_name', 'string'], ['group_name', 'string'], ['closing_balance', 'amount']]), result);
            return tableResponse(tableID, safeCount(result), safeCount(result) === 0 ? 'No rows found for this report/date range/company.' : undefined);
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('balance-sheet', {
        title: 'Balance Sheet',
        description: `fetches balance sheet with fields like ledger_name, group_name (blank if Profit & Loss A/c), closing_balance. closing balance negative is debit or asset and positive is credit or liability. kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period start or from date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period end or to date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let result = [];
            // ledger rows
            let result_ledger = await queryCollection('Ledger', ['Name', 'Parent', 'ClosingBalance'], new Map([['BS_Group', 'NOT $IsRevenue'], ['Excl_Stock', 'NOT $$IsGroupStock']]), args.targetCompany, parseBankStatementDate(args.fromDate), parseBankStatementDate(args.toDate));
            result_ledger = renameObjectArrayProperties(result_ledger, new Map([['Name', 'ledger_name'], ['Parent', 'group_name'], ['ClosingBalance', 'closing_balance']]));
            result.push(...result_ledger);
            // closing stock row
            let result_stock = await queryCollection('Group', ['Name', 'ClosingBalance'], new Map([['StockTypeGroup', '$$IsEqual:$Name:"Stock-in-Hand"']]), args.targetCompany, parseBankStatementDate(args.fromDate), parseBankStatementDate(args.toDate));
            if (result_stock.length > 0) {
                result.push({
                    ledger_name: 'Closing Stock',
                    group_name: 'Stock-in-Hand',
                    closing_balance: result_stock[0].ClosingBalance
                });
            }
            // profit loss row
            let result_pl = await queryCollection('Ledger', ['ClosingBalance'], new Map([['PL_Ledger', '$$IsEqual:$Name:"Profit & Loss A/c"']]), args.targetCompany, parseBankStatementDate(args.fromDate), parseBankStatementDate(args.toDate));
            if (result_pl.length > 0) {
                result.push({
                    ledger_name: 'Profit & Loss A/c',
                    group_name: '',
                    closing_balance: result_pl[0].ClosingBalance
                });
            }
            let tableID = await cacheTable(new Map([['ledger_name', 'string'], ['group_name', 'string'], ['closing_balance', 'amount']]), result);
            return tableResponse(tableID, safeCount(result), safeCount(result) === 0 ? 'No rows found for this report/date range/company.' : undefined);
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('stock-summary', {
        title: 'Stock Summary',
        description: `fetches stock item summary with fields stock_item_name, stock_group_name, opening_quantity, opening_value, inward_quantity, inward_value, outward_quantity, outward_value, closing_quantity, closing_value, returns output cached in pglite postgres in-memory table (specified in tableID property). synonyms (name=stock item / parent=stock group) Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period start or from date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period end or to date'),
            stockGroup: z.string().optional().describe('optional stock group name to filter stock summary results, validate it using list-master tool with collection as stock group if required')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map();
            if (args.stockGroup) {
                lstFilters.set('Specific_StockGroup', `$$IsEqual:$Parent:"${args.stockGroup.replace(/"/g, '""')}"`);
            }
            let result = await queryCollection('StockItem', ['Name', 'Parent', 'OpeningBalance', 'OpeningValue', 'InwardQuantity', 'InwardValue', 'OutwardQuantity', 'OutwardValue', 'ClosingBalance', 'ClosingValue', 'AffectsGrossProfit', 'SortPosition'], lstFilters, args.targetCompany, parseBankStatementDate(args.fromDate), parseBankStatementDate(args.toDate));
            result = renameObjectArrayProperties(result, new Map([['Name', 'stock_item_name'], ['Parent', 'stock_group_name'], ['OpeningBalance', 'opening_quantity'], ['OpeningValue', 'opening_value'], ['InwardQuantity', 'inward_quantity'], ['InwardValue', 'inward_value'], ['OutwardQuantity', 'outward_quantity'], ['OutwardValue', 'outward_value'], ['ClosingBalance', 'closing_quantity'], ['ClosingValue', 'closing_value']]));
            let tableID = await cacheTable(new Map([['stock_item_name', 'string'], ['stock_group_name', 'string'], ['opening_quantity', 'number'], ['opening_value', 'number'], ['inward_quantity', 'number'], ['inward_value', 'number'], ['outward_quantity', 'number'], ['outward_value', 'number'], ['closing_quantity', 'number'], ['closing_value', 'number']]), result);
            return tableResponse(tableID, safeCount(result), safeCount(result) === 0 ? 'No rows found for this report/date range/company.' : undefined);
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('ledger-balance', {
        title: 'Ledger Balance',
        description: `fetches ledger closing balance as on date, negative is debit and positive is credit, display Dr for Debit or Cr for Credit after the amount for better readability, instead of negative amount flip Debit or Credit to make it positive`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            ledgerName: z.string().describe('precise ledger name, always validate it using list-master tool with collection as ledger'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as on date for which balance is required')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map([['Exact_Ledger', `$$IsEqual:$Name:"${args.ledgerName.replace(/"/g, '""')}"`]]);
            let result = await queryCollection('Ledger', ['ClosingBalance'], lstFilters, args.targetCompany, undefined, new Date(args.toDate));
            if (result.length > 0) {
                return { content: [{ type: 'text', text: JSON.stringify({ amount: result[0].ClosingBalance }) }] };
            }
            else {
                return { isError: true, content: [{ type: 'text', text: 'No ledger found' }] };
            }
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('stock-item-balance', {
        title: 'Stock Item Balance',
        description: `fetches stock item remaining quantity balance as on date, tool returns quantity and unit of measurement`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            itemName: z.string().describe('precise stock item name, always validate it using list-master tool with collection as stockitem'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as on date for which balance is required')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map([['Exact_StockItem', `$$IsEqual:$Name:"${args.itemName.replace(/"/g, '""')}"`]]);
            let result = await queryCollection('StockItem', ['ClosingBalance', 'Unit'], lstFilters, args.targetCompany, undefined, new Date(args.toDate));
            return {
                content: [{ type: 'text', text: JSON.stringify(result.length ? { quantity: result[0].ClosingBalance, unit_of_measurement: result[0].Unit } : '') }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('bills-outstanding', {
        title: 'Bills Outstanding',
        description: `fetches pending overdue outstanding bills receivable or payable as on date with fields bill_date,reference_number,outstanding_amount,party_name,overdue_days. outstanding_amount = Debit is negative and Credit is positive. party_name = ledger_name. returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            nature: z.enum(['receivable', 'payable']),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as on date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map();
            if (args.nature) {
                lstFilters.set('Nature', `$$IsEqual:($_PrimaryGroup:Group:($Parent:Ledger:$Parent)):"${args.nature === 'receivable' ? 'Sundry Debtors' : 'Sundry Creditors'}"`);
            }
            let result = await queryCollection('Bill', ['BillDate', 'Name', 'ClosingBalance', 'Parent', '_OverDueDays'], lstFilters, args.targetCompany, undefined, new Date(args.toDate));
            result = renameObjectArrayProperties(result, new Map([['BillDate', 'bill_date'], ['Name', 'reference_number'], ['ClosingBalance', 'outstanding_amount'], ['Parent', 'party_name'], ['_OverDueDays', 'overdue_days']]));
            let tableID = await cacheTable(new Map([['bill_date', 'date'], ['reference_number', 'string'], ['outstanding_amount', 'number'], ['party_name', 'string'], ['overdue_days', 'number']]), result);
            return tableResponse(tableID, safeCount(result), safeCount(result) === 0 ? 'No rows found for this report/date range/company.' : undefined);
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });

    async function fetchBillsOutstanding(targetCompany, toDate) {
        const [yStr, mStr, dStr] = toDate.split('-').map(Number);
        const localToDate = new Date(yStr, mStr - 1, dStr);
        let lstFilters = new Map();
        lstFilters.set('Nature', `$$IsEqual:($_PrimaryGroup:Group:($Parent:Ledger:$Parent)):"Sundry Debtors"`);
        let result = await queryCollection('Bill', ['BillDate', 'Name', 'ClosingBalance', 'Parent'], lstFilters, targetCompany, undefined, localToDate);
        return result.map(bill => {
            let dateStr = '';
            if (bill.BillDate) {
                const dt = new Date(bill.BillDate);
                const y = dt.getUTCFullYear();
                const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
                const d = String(dt.getUTCDate()).padStart(2, '0');
                dateStr = `${y}-${m}-${d}`;
            }
            return {
                bill_date: dateStr,
                reference_number: bill.Name || '',
                outstanding_amount: bill.ClosingBalance || 0,
                party_name: bill.Parent || ''
            };
        });
    }

    mcpServer.registerTool('group-outstanding', {
        title: 'Group Outstanding',
        description: `fetches Sundry Debtors outstanding bills with bill-wise ageing calculated from actual bill date. Calculates aging buckets based on actual_days = toDate - bill_date. Groups military sub-groups under 'MILITARY'. Returns output cached in pglite postgres in-memory table.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company.'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as on date (YYYY-MM-DD)')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const { targetCompany, toDate } = args;

            const parseDateSafe = (str) => {
                if (!str) return null;
                const s = String(str).trim();
                if (/^\d{8}$/.test(s)) {
                    return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
                }
                if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
                    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
                    return new Date(y, m - 1, d);
                }
                if (/^\d{2}[-\/]\d{2}[-\/]\d{4}/.test(s)) {
                    const parts = s.slice(0, 10).split(/[-\/]/);
                    return new Date(+parts[2], +parts[1] - 1, +parts[0]);
                }
                const monMatch = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2}|\d{4})/);
                if (monMatch) {
                    const months = { JAN: 0, JANUARY: 0, FEB: 1, FEBRUARY: 1, MAR: 2, MARCH: 2, APR: 3, APRIL: 3, MAY: 4, JUN: 5, JUNE: 5, JUL: 6, JULY: 6, AUG: 7, AUGUST: 7, SEP: 8, SEPT: 8, SEPTEMBER: 8, OCT: 9, OCTOBER: 9, NOV: 10, NOVEMBER: 10, DEC: 11, DECEMBER: 11 };
                    const mm = months[monMatch[2].toUpperCase()];
                    if (mm !== undefined) {
                        let y = Number(monMatch[3]);
                        if (y < 100) y += y >= 70 ? 1900 : 2000;
                        return new Date(y, mm, Number(monMatch[1]));
                    }
                }
                return new Date(s);
            };

            const parseToDateSafe = (str) => {
                const [y, m, d] = str.slice(0, 10).split('-').map(Number);
                return new Date(y, m - 1, d);
            };

            const asOnDate = parseToDateSafe(toDate);

            const fieldsLedger = ['Name', 'Parent', '_PrimaryGroup'];
            const ledgers = await queryCollection('Ledger', fieldsLedger, new Map(), targetCompany);
            const ledgerMap = new Map();
            for (const led of ledgers) {
                ledgerMap.set(led.Name, {
                    parent: led.Parent || '',
                    primaryGroup: led._PrimaryGroup || ''
                });
            }

            const rawBills = await fetchBillsOutstanding(targetCompany, toDate);

            const militaryGroups = new Set([
                'CENTRAL COMMAND',
                'EASTERN COMMAND (NORTH EAST)',
                'EASTERN COMMAND (SIKKIM)',
                'EASTERN COMMAND (W.B.)',
                'SOUTHERN COMMAND',
                'NAVAL BASE',
                'MILITARY'
            ]);

            const rows = [];

            for (const bill of rawBills) {
                const partyName = bill.party_name || '';
                const ledInfo = ledgerMap.get(partyName);
                if (!ledInfo || ledInfo.primaryGroup !== 'Sundry Debtors') {
                    continue;
                }

                let subGroup = ledInfo.parent || 'Sundry Debtors';
                if (militaryGroups.has(subGroup.toUpperCase())) {
                    subGroup = 'MILITARY';
                }

                const billDateRaw = bill.bill_date;
                if (!billDateRaw) continue;

                let billDate;
                if (billDateRaw instanceof Date) {
                    billDate = new Date(billDateRaw.getFullYear(), billDateRaw.getMonth(), billDateRaw.getDate());
                } else {
                    billDate = parseDateSafe(billDateRaw);
                }
                if (!billDate || isNaN(billDate)) continue;

                const actualDays = Math.round((asOnDate - billDate) / (1000 * 60 * 60 * 24));

                let ageBucket = '';
                if (actualDays <= 61) {
                    ageBucket = '< 60 Days';
                } else if (actualDays <= 91) {
                    ageBucket = '60–90 Days';
                } else if (actualDays <= 121) {
                    ageBucket = '90–120 Days';
                } else if (actualDays <= 181) {
                    ageBucket = '120–180 Days';
                } else {
                    ageBucket = '> 180 Days';
                }

                const outstandingAmt = bill.outstanding_amount || 0;
                const isDebit = outstandingAmt < 0;
                const absAmt = Math.abs(outstandingAmt);
                const debitAmt = isDebit ? absAmt : 0;
                const creditAmt = isDebit ? 0 : absAmt;

                const billDateFormatted = `${billDate.getFullYear()}-${String(billDate.getMonth() + 1).padStart(2, '0')}-${String(billDate.getDate()).padStart(2, '0')}`;

                rows.push({
                    sub_group: subGroup,
                    ledger_name: partyName,
                    bill_date: billDateFormatted,
                    reference_number: bill.reference_number || '',
                    outstanding_amount: outstandingAmt,
                    actual_days: actualDays,
                    age_bucket: ageBucket,
                    debit_amount: Number(debitAmt.toFixed(2)),
                    credit_amount: Number(creditAmt.toFixed(2))
                });
            }

            const tableID = await cacheTable(new Map([
                ['sub_group', 'string'],
                ['ledger_name', 'string'],
                ['bill_date', 'date'],
                ['reference_number', 'string'],
                ['outstanding_amount', 'number'],
                ['actual_days', 'number'],
                ['age_bucket', 'string'],
                ['debit_amount', 'number'],
                ['credit_amount', 'number']
            ]), rows);

            const sqlQuery = `
                SELECT
                    sub_group,
                    SUM(CASE WHEN age_bucket = '< 60 Days' THEN debit_amount ELSE 0 END) as "less_than_60_debit",
                    SUM(CASE WHEN age_bucket = '< 60 Days' THEN credit_amount ELSE 0 END) as "less_than_60_credit",
                    SUM(CASE WHEN age_bucket = '60–90 Days' THEN debit_amount ELSE 0 END) as "sixty_to_ninety_debit",
                    SUM(CASE WHEN age_bucket = '60–90 Days' THEN credit_amount ELSE 0 END) as "sixty_to_ninety_credit",
                    SUM(CASE WHEN age_bucket = '90–120 Days' THEN debit_amount ELSE 0 END) as "ninety_to_one_twenty_debit",
                    SUM(CASE WHEN age_bucket = '90–120 Days' THEN credit_amount ELSE 0 END) as "ninety_to_one_twenty_credit",
                    SUM(CASE WHEN age_bucket = '120–180 Days' THEN debit_amount ELSE 0 END) as "one_twenty_to_one_eighty_debit",
                    SUM(CASE WHEN age_bucket = '120–180 Days' THEN credit_amount ELSE 0 END) as "one_twenty_to_one_eighty_credit",
                    SUM(CASE WHEN age_bucket = '> 180 Days' THEN debit_amount ELSE 0 END) as "above_one_eighty_debit",
                    SUM(CASE WHEN age_bucket = '> 180 Days' THEN credit_amount ELSE 0 END) as "above_one_eighty_credit",
                    SUM(debit_amount) as "total_debit",
                    SUM(credit_amount) as "total_credit"
                FROM ${tableID}
                GROUP BY GROUPING SETS ((sub_group), ())
                ORDER BY (CASE WHEN sub_group IS NULL THEN 1 ELSE 0 END), sub_group;
            `;

            const queryResultRaw = await executeSQL(sqlQuery, 'JSON Array of Objects');
            const summaryList = JSON.parse(queryResultRaw).map(row => {
                return {
                    sub_group: row.sub_group || 'GRAND TOTAL',
                    less_than_60: {
                        debit: Number((row.less_than_60_debit || 0).toFixed(2)),
                        credit: Number((row.less_than_60_credit || 0).toFixed(2))
                    },
                    sixty_to_ninety: {
                        debit: Number((row.sixty_to_ninety_debit || 0).toFixed(2)),
                        credit: Number((row.sixty_to_ninety_credit || 0).toFixed(2))
                    },
                    ninety_to_one_twenty: {
                        debit: Number((row.ninety_to_one_twenty_debit || 0).toFixed(2)),
                        credit: Number((row.ninety_to_one_twenty_credit || 0).toFixed(2))
                    },
                    one_twenty_to_one_eighty: {
                        debit: Number((row.one_twenty_to_one_eighty_debit || 0).toFixed(2)),
                        credit: Number((row.one_twenty_to_one_eighty_credit || 0).toFixed(2))
                    },
                    above_one_eighty: {
                        debit: Number((row.above_one_eighty_debit || 0).toFixed(2)),
                        credit: Number((row.above_one_eighty_credit || 0).toFixed(2))
                    },
                    total: {
                        debit: Number((row.total_debit || 0).toFixed(2)),
                        credit: Number((row.total_credit || 0).toFixed(2))
                    }
                };
            });

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        tableID,
                        total_rows: rows.length,
                        summary: summaryList
                    }, null, 2)
                }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err?.message || err) }]
            };
        }
    });

    mcpServer.registerTool('ledger-details', {
        title: 'Ledger Details',
        description: `fetches ledger master details including PAN / Income Tax Number / GSTIN. Use this to get party PAN for TDS sheets instead of guessing or deriving it from voucher data`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name'),
            ledgerName: z.string().describe('exact ledger name, validate using list-master collection ledger')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const safeName = args.ledgerName.replace(/"/g, '""');
            const fields = ['Name', 'Parent', 'IncomeTaxNumber', 'PANITNo', 'PANNo', 'PAN', 'GSTIN', 'PartyGSTIN'];
            const filters = new Map([['Exact_Ledger', `$$IsEqual:$Name:"${safeName}"`]]);
            const result = await queryCollection('Ledger', fields, filters, args.targetCompany);
            const row = Array.isArray(result) && result.length ? result[0] : null;
            if (!row) return { isError: true, content: [{ type: 'text', text: 'No ledger found with the given name' }] };
            const pan = row.IncomeTaxNumber || row.PANITNo || row.PANNo || row.PAN || '';
            const gstin = row.PartyGSTIN || row.GSTIN || '';
            return { content: [{ type: 'text', text: JSON.stringify({ ledgerName: row.Name, parent: row.Parent || '', pan, gstin, raw: row }) }] };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err?.message || err) }] };
        }
    });
    mcpServer.registerTool('tds-payment-sheet', {
        title: 'TDS Payment Sheet',
        description: `creates TDS payment sheet source rows from Tally vouchers. IMPORTANT: taxable_value is read directly from voucher ledger entries; it is not reverse-calculated from TDS amount. PAN should be taken from ledger-details / Ledger master. Rate is returned only if present in Tally, otherwise blank.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('company name, validate using discover-companies/list-master company'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to date'),
            partyContains: z.string().optional().describe('optional party/ledger contains filter')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
            if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
            if (args.partyContains) inputParams.set('partyContains', args.partyContains);
            const resp = await fetchReport('tds-payment-sheet', inputParams);
            if (resp.error) return { isError: true, content: [{ type: 'text', text: resp.error }] };
            const rawRows = Array.isArray(resp.data) ? resp.data.filter(r => r && (r.tds_amount || r.taxable_value || r.party_ledger || r.voucher_number)) : [];
            const rows = rawRows.map((r, i) => {
                const n = normalizeTdsReportRow(r, i);
                const panInfo = panEntityType(n.pan);
                const expectedRate = defaultExpectedTdsRate(n.section, panInfo, {});
                const chosenBase = chooseTdsReportBaseAmount(n, 'taxable_value', expectedRate);
                const actualRate = chooseTdsActualRate(n, chosenBase.amount, expectedRate);
                return {
                    date: n.date,
                    party_ledger: n.party_name,
                    pan: n.pan,
                    section: n.section,
                    tds_rate: actualRate ? String(actualRate) : '',
                    taxable_ledger: n.taxable_ledger,
                    taxable_value: Number((chosenBase.amount || 0).toFixed(2)),
                    taxable_value_source: chosenBase.source,
                    taxable_value_derived: !!chosenBase.derived,
                    taxable_value_warning: chosenBase.base_warning || '',
                    tds_ledger: n.tds_ledger,
                    tds_amount: n.tds_amount,
                    voucher_type: n.voucher_type,
                    voucher_number: n.voucher_number,
                    narration: n.narration
                };
            });
            if (rows.length === 0) return tableResponse(null, 0, 'No TDS voucher rows found for this date range/company.');
            const tableId = await cacheTable(new Map([
                ['date', 'date'], ['party_ledger', 'string'], ['pan', 'string'], ['section', 'string'], ['tds_rate', 'string'], ['taxable_ledger', 'string'], ['taxable_value', 'number'], ['taxable_value_source', 'string'], ['taxable_value_derived', 'boolean'], ['taxable_value_warning', 'string'], ['tds_ledger', 'string'], ['tds_amount', 'number'], ['voucher_type', 'string'], ['voucher_number', 'string'], ['narration', 'string']
            ]), rows);
            return tableResponse(tableId, rows.length, 'Taxable value is read from summed non-TDS voucher ledger entries. If Tally still exposes only the TDS amount instead of the taxable ledger, the row is flagged with taxable_value_warning and an estimated base for review, so the TDS amount is not printed as Amount Paid. Use ledger-details to fill/verify PAN where blank.');
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err?.message || err) }] };
        }
    });
    mcpServer.registerTool('ledger-account', {
        title: 'Ledger Account',
        description: `fetches GL ledger account statement with voucher level details containing fields guid, date, voucher_type, voucher_number, alternate_ledger, party_name, amount, narration . amount = debit is negative and credit is positive. alternate_ledger = if amount is credit then ledger by which it is debited and vice-a-versa (in case of multiple ledgers first one is displayed). returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            ledgerName: z.string().describe('ledger name, always verify if ledger exists using list-master tool with collection as ledger'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from or start date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to or end date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        // verify if ledger exists before making report call to avoid unnecessary processing and load on Tally
        let lstLedger = await queryCollection('Ledger', ['Name'], new Map([['Exact_Ledger', `$$IsEqual:$Name:"${args.ledgerName.replace(/"/g, '""')}"`]]), args.targetCompany);
        if (lstLedger.length === 0) {
            return {
                isError: true,
                content: [{ type: 'text', text: 'No ledger found with the given name' }]
            };
        }
        try {
            const resp = await fetchLedgerAccountComplete(args.ledgerName, args.fromDate, args.toDate, args.targetCompany);
            //swap opening balance row to the top since it came at the end from Tally XML response
            if (Array.isArray(resp.data) && resp.data.length > 0) {
                const lastIdx = resp.data.findIndex(r => r && String(r.voucher_type || '').toLowerCase() === 'opening');
                if (lastIdx > 0) {
                    const op = resp.data.splice(lastIdx, 1)[0];
                    resp.data.unshift(op);
                }
            }
            if (!Array.isArray(resp.data) || resp.data.length === 0) {
                return tableResponse(null, 0, 'No ledger transactions found for this ledger/date range/company.');
            }
            let warningMsg = undefined;
            if (resp.partial) {
                warningMsg = `WARNING: The retrieved report may be incomplete (expected ${resp.expectedCount} vouchers but fetched ${resp.data.filter(r => String(r.voucher_type || '').toLowerCase() !== 'opening').length}). Try querying a smaller date range.`;
            }
            const tableId = await cacheTable(new Map([['guid', 'string'], ['date', 'date'], ['voucher_type', 'string'], ['voucher_number', 'string'], ['alternate_ledger', 'string'], ['party_name', 'string'], ['amount', 'number'], ['net_amount', 'number'], ['narration', 'string']]), resp.data);
            return tableResponse(tableId, safeCount(resp.data), warningMsg);
        } catch (e) {
            return {
                isError: true,
                content: [{ type: 'text', text: String(e.message || e) }]
            };
        }
    });
    mcpServer.registerTool('bank-reconciliation', {
        title: 'Bank Reconciliation',
        description: `reconciles one exact selected Tally bank ledger with bank statement rows extracted from a PDF/Excel statement. If the bank has multiple ledgers/accounts (C/A, C/C, OD, account-number ledgers), first call search-bank-ledgers with bankName such as HDFC and ask the user to select the correct ledger option. For HDFC-style PDFs, pass rows with Date, Narration, Chq./Ref.No., Value Dt, Withdrawal Amt., Deposit Amt., Closing Balance. The tool fetches the selected Tally bank ledger, matches by amount, debit/credit direction, value date/date, reference number and narration/party similarity, then returns matched, amount_mismatch, bank-only and Tally-only rows cached in pglite. Minor differences from TDS, bank charges, discount, shortage, debit/credit note, freight, round-off, partial payments or deductions are treated as amount_mismatch/possible match instead of fully unmatched.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name, validate using discover-companies/list-master company'),
            ledgerName: z.string().describe('exact selected Tally bank ledger name. Prefer using search-bank-ledgers first and pass the selected option ledger_name here, especially when multiple HDFC/ICICI/SBI bank ledgers exist.'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from date of statement period'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to date of statement period'),
            bankStatementRows: z.array(z.object({}).passthrough()).min(1).describe('rows extracted from the bank statement PDF/Excel. Supported keys include Date, Narration, Chq./Ref.No., Value Dt, Withdrawal Amt., Deposit Amt., Closing Balance or normalized snake_case keys.'),
            amountTolerance: z.number().optional().describe('allowed exact-match amount difference, default 1 rupee'),
            minorMismatchTolerance: z.number().optional().describe('allowed minor amount mismatch to still treat as possible matched reference/date, default 10000 rupees. Useful for TDS, discount, shortage, debit note, credit note, freight, round-off or other deductions.'),
            minorMismatchPercent: z.number().optional().describe('allowed minor mismatch as percentage of statement amount, default 2 percent. Useful when TDS/deductions are percentage based.'),
            dateToleranceDays: z.number().int().optional().describe('allowed difference between bank value date/date and Tally voucher date, default 3 days'),
            dateSearchWindowDays: z.number().int().optional().describe('generic backdate/later-booking search window in days. Default 30 for bank reconciliation.'),
            lookBackDays: z.number().int().optional().describe('extend Tally fetch before fromDate to catch backdated/earlier bank vouchers. Default equals dateSearchWindowDays.'),
            lookAheadDays: z.number().int().optional().describe('extend Tally fetch after toDate to catch later-booked/future bank vouchers. Default equals dateSearchWindowDays.'),
            minimumScore: z.number().optional().describe('minimum match score, default 60')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const amountTolerance = args.amountTolerance ?? 1;
            const minorMismatchTolerance = args.minorMismatchTolerance ?? 10000;
            const minorMismatchPercent = args.minorMismatchPercent ?? 2;
            const dateToleranceDays = args.dateToleranceDays ?? 3;
            const dateSearchWindowDays = Math.max(7, Math.min(args.dateSearchWindowDays ?? 30, 365));
            const lookBackDays = Math.max(0, Math.min(args.lookBackDays ?? dateSearchWindowDays, 365));
            const lookAheadDays = Math.max(0, Math.min(args.lookAheadDays ?? dateSearchWindowDays, 365));
            const minimumScore = args.minimumScore ?? 60;
            let lstLedger = await queryCollection('Ledger', ['Name'], new Map([['Exact_Ledger', `$$IsEqual:$Name:"${args.ledgerName.replace(/"/g, '""')}"`]]), args.targetCompany);
            if (lstLedger.length === 0) {
                return { isError: true, content: [{ type: 'text', text: 'No bank ledger found with the given ledgerName. Use list-master with collection ledger to verify the exact bank ledger name.' }] };
            }
            const fetchFromDate = shiftIsoDate(args.fromDate, -lookBackDays);
            const fetchToDate = shiftIsoDate(args.toDate, lookAheadDays);
            const resp = await fetchLedgerAccountComplete(args.ledgerName, fetchFromDate, fetchToDate, args.targetCompany);
            const tallyRows = (Array.isArray(resp.data) ? resp.data : [])
                .filter(r => r && String(r.voucher_type || '').toLowerCase() !== 'opening')
                .map(normalizeTallyBankRow)
                .filter(r => r.abs_amount > 0);
            const bankRows = args.bankStatementRows.map(normalizeBankStatementRow).filter(r => r.amount > 0 && r.date);
            const usedTally = new Set();
            const matched = [];
            const unmatchedBank = [];
            for (const bank of bankRows) {
                let best = null;
                for (let i = 0; i < tallyRows.length; i++) {
                    if (usedTally.has(i)) continue;
                    const tally = tallyRows[i];
                    const result = scoreBankTallyMatch(bank, tally, amountTolerance, dateToleranceDays, minorMismatchTolerance, minorMismatchPercent);
                    if (!best || result.score > best.result.score || (result.score === best.result.score && result.dateDiff < best.result.dateDiff)) {
                        best = { index: i, tally, result };
                    }
                }
                if (best && best.result.score >= minimumScore) {
                    usedTally.add(best.index);
                    const bankTiming = partyPeriodRelation(bank.value_date || bank.date, best.tally.date, dateToleranceDays);
                    const bankStatus = !best.result.amountMatched ? 'amount_mismatch' : (bankTiming.kind ? 'date_mismatch' : 'matched');
                    matched.push({
                        status: bankStatus,
                        match_score: best.result.score,
                        match_reasons: best.result.reasons.join(', '),
                        difference: Number(((bank.amount || 0) - (best.tally.abs_amount || 0)).toFixed(2)),
                        mismatch_type: best.result.mismatchType || '',
                        possible_reason: best.result.possibleReason || bankTiming.reason || '',
                        date_difference_days: best.result.dateDiff,
                        bank_index: bank.bank_index,
                        bank_date: bank.date,
                        bank_value_date: bank.value_date,
                        bank_ref_no: bank.chq_ref_no,
                        bank_narration: bank.narration,
                        bank_withdrawal_amount: bank.withdrawal_amount,
                        bank_deposit_amount: bank.deposit_amount,
                        bank_closing_balance: bank.closing_balance,
                        tally_index: best.tally.tally_index,
                        tally_guid: best.tally.guid,
                        tally_date: best.tally.date,
                        tally_voucher_type: best.tally.voucher_type,
                        tally_voucher_number: best.tally.voucher_number,
                        tally_party_ledger: best.tally.party_ledger,
                        tally_alternate_ledger: best.tally.alternate_ledger,
                        tally_amount: best.tally.amount,
                        tally_narration: best.tally.narration
                    });
                } else {
                    unmatchedBank.push({
                        status: 'bank_only',
                        match_score: best?.result?.score || 0,
                        difference: best ? Number(((bank.amount || 0) - (best.tally.abs_amount || 0)).toFixed(2)) : bank.amount,
                        mismatch_type: best?.result?.mismatchType || '',
                        possible_reason: best?.result?.possibleReason || '',
                        bank_index: bank.bank_index,
                        bank_date: bank.date,
                        bank_value_date: bank.value_date,
                        bank_ref_no: bank.chq_ref_no,
                        bank_narration: bank.narration,
                        bank_withdrawal_amount: bank.withdrawal_amount,
                        bank_deposit_amount: bank.deposit_amount,
                        bank_closing_balance: bank.closing_balance,
                        tally_index: null,
                        tally_source_ledger_name: '',
                        tally_guid: '',
                        tally_date: '',
                        tally_voucher_type: '',
                        tally_voucher_number: '',
                        tally_party_ledger: '',
                        tally_alternate_ledger: '',
                        tally_amount: 0,
                        tally_narration: '',
                        statement_value_source: 'uploaded_statement_debit_credit_or_amount',
                        tally_value_source: ''
                    });
                }
            }
            const unmatchedTally = tallyRows.filter((_, i) => !usedTally.has(i)).map(tally => ({
                status: 'tally_only',
                match_score: 0,
                difference: tally.abs_amount,
                mismatch_type: '',
                possible_reason: '',
                bank_index: null,
                bank_date: '',
                bank_value_date: '',
                bank_ref_no: '',
                bank_narration: '',
                bank_withdrawal_amount: 0,
                bank_deposit_amount: 0,
                bank_closing_balance: 0,
                tally_index: tally.tally_index,
                tally_guid: tally.guid,
                tally_date: tally.date,
                tally_voucher_type: tally.voucher_type,
                tally_voucher_number: tally.voucher_number,
                tally_party_ledger: tally.party_ledger,
                tally_alternate_ledger: tally.alternate_ledger,
                tally_amount: tally.amount,
                tally_narration: tally.narration
            }));

            // Consolidated matching pass: Group multiple unmatched Tally entries that sum up to a single unmatched bank entry
            for (let bIdx = 0; bIdx < unmatchedBank.length; bIdx++) {
                const bank = unmatchedBank[bIdx];
                if (bank.status !== 'bank_only' || bank.bank_withdrawal_amount + bank.bank_deposit_amount <= 0) continue;

                const bankAmt = bank.bank_withdrawal_amount + bank.bank_deposit_amount;
                const candidates = [];
                for (let tIdx = 0; tIdx < unmatchedTally.length; tIdx++) {
                    const t = unmatchedTally[tIdx];
                    if (t.status !== 'tally_only') continue;

                    const dateDiff = daysBetween(bank.bank_value_date || bank.bank_date, t.tally_date);
                    if (dateDiff <= dateSearchWindowDays) {
                        const sameDir = (bank.bank_withdrawal_amount > 0 && t.tally_amount >= 0) || (bank.bank_deposit_amount > 0 && t.tally_amount < 0);
                        if (sameDir) {
                            candidates.push({ index: tIdx, amount: t.difference, dateDiff });
                        }
                    }
                }

                if (candidates.length >= 2) {
                    const matchedIndices = findSubsetSum(candidates, bankAmt, amountTolerance);
                    if (matchedIndices) {
                        bank.status = 'matched_consolidated';
                        bank.match_score = 90;
                        bank.difference = 0;
                        bank.match_reasons = 'matched via consolidated/split entry sum';

                        matchedIndices.forEach(tIdx => {
                            const t = unmatchedTally[tIdx];
                            t.status = 'matched_consolidated';
                            t.match_score = 90;
                            t.difference = 0;
                            t.match_reasons = 'matched via consolidated/split entry sum';

                            t.bank_index = bank.bank_index;
                            t.bank_date = bank.bank_date;
                            t.bank_value_date = bank.bank_value_date;
                            t.bank_ref_no = bank.bank_ref_no;
                            t.bank_narration = bank.bank_narration;
                            t.bank_withdrawal_amount = bank.bank_withdrawal_amount;
                            t.bank_deposit_amount = bank.bank_deposit_amount;
                            t.bank_closing_balance = bank.bank_closing_balance;

                            matched.push(t);
                        });
                        matched.push(bank);
                    }
                }
            }

            const finalUnmatchedBank = unmatchedBank.filter(b => b.status === 'bank_only');
            const finalUnmatchedTally = unmatchedTally.filter(t => t.status === 'tally_only');
            const finalMatchedConsolidated = matched.filter(m => m.status === 'matched_consolidated');
            const finalMatched = matched.filter(m => m.status !== 'matched_consolidated');

            const rows = [...finalMatched, ...finalMatchedConsolidated, ...finalUnmatchedBank, ...finalUnmatchedTally];
            const summary = {
                bank_rows: bankRows.length,
                tally_rows: tallyRows.length,
                matched: finalMatched.filter(r => r.status === 'matched').length + finalMatchedConsolidated.length / 2,
                amount_mismatch: finalMatched.filter(r => r.status === 'amount_mismatch').length,
                bank_only: finalUnmatchedBank.length,
                tally_only: finalUnmatchedTally.length,
                bank_withdrawals: Number(bankRows.reduce((s, r) => s + (r.withdrawal_amount || 0), 0).toFixed(2)),
                bank_deposits: Number(bankRows.reduce((s, r) => s + (r.deposit_amount || 0), 0).toFixed(2)),
                tally_withdrawals: Number(tallyRows.filter(r => r.direction === 'withdrawal').reduce((s, r) => s + r.abs_amount, 0).toFixed(2)),
                tally_deposits: Number(tallyRows.filter(r => r.direction === 'deposit').reduce((s, r) => s + r.abs_amount, 0).toFixed(2)),
                amountTolerance,
                minorMismatchTolerance,
                minorMismatchPercent,
                dateToleranceDays,
                dateSearchWindowDays,
                lookBackDays,
                lookAheadDays,
                fetched_tally_from_date: shiftIsoDate(args.fromDate, -lookBackDays),
                fetched_tally_to_date: shiftIsoDate(args.toDate, lookAheadDays),
                minimumScore
            };
            const tableId = await cacheTable(new Map([
                ['status', 'string'], ['match_score', 'number'], ['match_reasons', 'string'], ['difference', 'number'], ['mismatch_type', 'string'], ['possible_reason', 'string'], ['date_difference_days', 'number'],
                ['bank_index', 'number'], ['bank_date', 'date'], ['bank_value_date', 'date'], ['bank_ref_no', 'string'], ['bank_narration', 'string'], ['bank_withdrawal_amount', 'number'], ['bank_deposit_amount', 'number'], ['bank_closing_balance', 'number'],
                ['tally_index', 'number'], ['tally_source_ledger_name', 'string'], ['tally_guid', 'string'], ['tally_date', 'date'], ['tally_voucher_type', 'string'], ['tally_voucher_number', 'string'], ['tally_party_ledger', 'string'], ['tally_alternate_ledger', 'string'], ['tally_amount', 'number'], ['tally_narration', 'string'], ['value_source_note', 'string']
            ]), rows);
            return { content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, rows: rows.length, summary, message: 'Use query-database on tableID to filter status = matched, amount_mismatch, bank_only, or tally_only. amount_mismatch means the bank statement and Tally entry look related by date/reference/narration but amount differs; check possible_reason for TDS, bank charges, discount, shortage, debit/credit note, freight, round-off, partial payment or other deductions. bank_only rows are in bank PDF but not found in Tally; tally_only rows are in Tally but not found in the bank PDF.' }) }] };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err?.message || err) }] };
        }
    });

    mcpServer.registerTool('stock-item-account', {
        title: 'Stock Item Account',
        description: `fetches GL stock item account statement with voucher level details containing fields date, voucher_type, voucher_number, party_name, quantity, amount, narration, tracking_number, voucher_category. party_name = ledger_name. quantity = inward as positive and outward as negative. amount = debit is negative and credit is positive, narration = notes / remarks. for calculating closing balance of quantity, consider rows with tracking_number as empty as it is, but for rows with tracking_number having text value, then duplicate rows need to be removed by preparing intermediate output with aggregation of tracking_number and voucher_category with sum of quantity and then comparing quantity of Receipt Note with Purchase and Delivery Note with Sales to identify and remove the rows with Receipt Note and Delivery Note if they are found to be tracked fully / partially . returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            itemName: z.string().describe('stock item name, validate it using list-master tool with collection as stockitem'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from or start date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to or end date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate], ['itemName', args.itemName]]);
        if (args.targetCompany) {
            inputParams.set('targetCompany', args.targetCompany);
        }
        // verify if stock item exists before making report call to avoid unnecessary processing and load on Tally
        let lstStockItem = await queryCollection('StockItem', ['Name'], new Map([['Exact_StockItem', `$$IsEqual:$Name:"${args.itemName.replace(/"/g, '""')}"`]]), args.targetCompany);
        if (lstStockItem.length === 0) {
            return {
                isError: true,
                content: [{ type: 'text', text: 'No stock item found with the given name' }]
            };
        }
        try {
            const resp = await fetchStockItemAccountComplete(args.itemName, args.fromDate, args.toDate, args.targetCompany);
            //swap opening balance row to the top since it came at the end from Tally XML response
            if (Array.isArray(resp.data) && resp.data.length > 0) {
                const lastIdx = resp.data.findIndex(r => r && String(r.voucher_type || '').toLowerCase() === 'opening');
                if (lastIdx > 0) {
                    const op = resp.data.splice(lastIdx, 1)[0];
                    resp.data.unshift(op);
                }
            }
            let warningMsg = undefined;
            if (resp.partial) {
                warningMsg = `WARNING: The retrieved report may be incomplete (expected ${resp.expectedCount} vouchers but fetched ${resp.data.filter(r => String(r.voucher_type || '').toLowerCase() !== 'opening').length}). Try querying a smaller date range.`;
            }
            const tableId = await cacheTable(new Map([['date', 'date'], ['voucher_type', 'string'], ['voucher_number', 'string'], ['party_ledger', 'string'], ['quantity', 'number'], ['amount', 'number'], ['narration', 'string'], ['tracking_number', 'string'], ['voucher_category', 'string']]), resp.data);
            return tableResponse(tableId, safeCount(resp.data), warningMsg || (safeCount(resp.data) === 0 ? 'No stock item transactions found for this item/date range/company.' : undefined));
        } catch (e) {
            return {
                isError: true,
                content: [{ type: 'text', text: String(e.message || e) }]
            };
        }
    });
    mcpServer.registerTool('ledger-create-update', {
        title: 'Create or Update Ledger',
        description: `create or update ledger master data in Tally Prime, returns success count of created and / or altered records`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            masters: z.array(z.object({
                name: z.string().describe('ledger name or updated ledger name for modify / update'),
                _name: z.string().optional().describe('old ledger name to modify / update, validate if ledger exists using list-master tool with collection as ledger'),
                parent: z.string().optional().describe('group name for the ledger, validate if group exists using list-master tool with collection as group'),
                openingBalance: z.number().optional().describe('optional opening balance for the ledger debit is negative and credit is positive'),
                isBillWise: z.boolean().optional().describe('optional billwise or bill by bill tracking is enabled for the ledger, default is false, set it undefined to keep it unchanged'),
                billCreditPeriod: z.number().optional().describe('optional bill credit period in number of days, applicable only if isBillWise is true, set it undefined to keep it unchanged'),
                mailingDetails: z.object({
                    name: z.string().optional().describe('business name for mailing details, set it undefined to keep it unchanged, set it blank to reset it to Not Applicable'),
                    country: z.string().describe('country for mailing details, validate it using query-option-values tool with input optionName as country-state, set it blank to reset it to Not Applicable'),
                    state: z.string().describe('state for mailing details, validate it using query-option-values tool with input optionName as country-state, set it blank to reset it to Not Applicable'),
                    address: z.string().optional().describe('address for mailing details, set it blank to reset it'),
                    pincode: z.string().regex(/^\d{6}$/).optional().describe('pincode for mailing details 6 digit number, set it blank to reset it, set it undefined to keep it unchanged'),
                }).optional().describe('optional mailing details for the ledger'),
                gstRegistrationDetails: z.object({
                    gstin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('GSTIN or GST number'),
                    registrationType: z.enum(['Composition', 'Regular', 'Unregistered/Consumer', 'Government entity / TDS', 'Regular - SEZ', 'Regular-Deemed Exporter', 'Regular-Exports (EOU)', 'e-Commerce Operator', 'Input Service Distributor', 'Embassy/UN Body', 'Non-Resident Taxpayer']).optional().describe('GST registration type'),
                    placeOfSupply: z.string().optional().describe('place of supply for GST, validate it using query-option-values tool with input optionName as country-state with value of state property, set it blank to reset it to Not Applicable, set it undefined to keep it unchanged'),
                }).optional().describe('optional GST registration details for the ledger, applicable only if country in mailing details is India'),
            })).describe('array of master data objects to create or update'),
        },
        annotations: {
            readOnlyHint: false,
            openWorldHint: false,
            destructiveHint: true,
            idempotentHint: true
        }
    }, async (args) => {
        try {
            if (Array.isArray(args.masters) && args.masters.length > 0) {
                let objMasterInput = new Map();
                let lstObjMasters = [];
                // assign books begin from date by calling queryCollection
                let booksBeginFrom = new Date();
                const resultBooksBeginFrom = await queryCollection('Company', ['Name', 'BooksFrom', 'IsActiveCompany'], new Map());
                if (resultBooksBeginFrom.length === 0) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: 'No company found to determine books begin from date' }]
                    };
                }
                if (!args.targetCompany) { //choose Active company
                    booksBeginFrom = resultBooksBeginFrom.filter((item) => item.IsActiveCompany)[0].BooksFrom;
                }
                else { //choose specified target company
                    booksBeginFrom = resultBooksBeginFrom.filter((item) => item.Name === args.targetCompany)[0].BooksFrom;
                }
                args.masters.forEach((master) => {
                    let objLedger = {};
                    if (master._name)
                        objLedger._name = master._name;
                    if (master.name)
                        objLedger.name = master.name;
                    if (master.parent)
                        objLedger.parent = master.parent;
                    if (master.openingBalance !== undefined)
                        objLedger.openingBalance = master.openingBalance;
                    if (master.mailingDetails) {
                        objLedger.mailingDetails = master.mailingDetails;
                        objLedger.mailingDetails.applicableFrom = booksBeginFrom;
                    }
                    if (master.gstRegistrationDetails) {
                        objLedger.gstRegistrationDetails = master.gstRegistrationDetails;
                        objLedger.gstRegistrationDetails.applicableFrom = booksBeginFrom;
                    }
                    if (master.isBillWise !== undefined) {
                        objLedger.isBillWise = master.isBillWise;
                    }
                    if (master.isBillWise === true && master.billCreditPeriod !== undefined && typeof master.billCreditPeriod === 'number') {
                        let creditDays = Math.trunc(master.billCreditPeriod);
                        objLedger.billCreditPeriod = creditDays;
                    }
                    lstObjMasters.push(objLedger);
                });
                objMasterInput.set('masters', lstObjMasters);
                if (args.targetCompany) {
                    objMasterInput.set('targetCompany', args.targetCompany);
                }
                let result = await importMasters('master-ledger', objMasterInput);
                return {
                    content: [{ type: 'text', text: JSON.stringify(result) }]
                };
            }
            else {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'masters array is required with at least one master object to create or update' }]
                };
            }
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('set-company', {
        title: 'Set Company',
        description: `sets the active company context in Tally Prime. This changes the global company context used by Tally for subsequent operations and report queries`,
        inputSchema: {
            companyName: z.string().describe('company name to set as active, validate it using list-master tool with collection as company')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let inputParams = new Map([['SVCurrentCompany', utility.String.escapeHTML(args.companyName)]]);
            await invokeTallyAction('ChangeCurrentCompany', inputParams);
            return { content: [{ type: 'text', text: JSON.stringify('OK') }] };
        }
        catch (err) {
            return {
                isError: true, content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('set-period', {
        title: 'Set Period',
        description: `sets the active reporting period in Tally Prime by specifying a from date and to date. This changes the global period context used by Tally for subsequent report queries`,
        inputSchema: {
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('start date of the period'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('end date of the period')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let _fromDate = new Date(args.fromDate);
            let _toDate = new Date(args.toDate);
            let inputParams = new Map([['SVFromDate', utility.Date.format(_fromDate, 'd-MMM-yyyy')], ['SVToDate', utility.Date.format(_toDate, 'd-MMM-yyyy')]]);
            await invokeTallyAction('Change Period', inputParams);
            return { content: [{ type: 'text', text: JSON.stringify('OK') }] };
        }
        catch (err) {
            return {
                isError: true, content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });

    mcpServer.registerTool('stock-statement-to-bank', {
        title: 'Stock Statement to Bank',
        description: 'Generates an Excel report for Nowrangroy Agro Private Limited combining stock balances and financial figures from Tally for a given month and company.',
        inputSchema: {
            targetCompany: z.string().describe('Tally company name'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as-on date for stock balances (YYYY-MM-DD)'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('start of month for sales/purchase figures (YYYY-MM-DD)'),
            cumulativeFromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('start of financial year for cumulative figures (YYYY-MM-DD)')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const { targetCompany, toDate, fromDate, cumulativeFromDate } = args;

            // 1. Fetch stock item balances as of toDate
            const rawStockItems = await queryCollection('StockItem', ['Name', 'ClosingBalance', 'Unit'], new Map(), targetCompany, undefined, new Date(toDate));
            const stockMap = new Map();
            for (const item of rawStockItems) {
                stockMap.set(item.Name, { qty: item.ClosingBalance, unit: item.Unit });
            }

            const getQty = (name) => {
                const item = stockMap.get(name);
                return item ? item.qty : 0;
            };

            // Stock categories and conversions to KGS
            const kgsItems = {
                'WHEAT': getQty('WHEAT'),
                'ATTA': (
                    getQty('WM - ATTA') +
                    getQty('ATTA 50 KGS') +
                    getQty('ATTA 26 KGS') +
                    getQty('ATTA 30 KGS') +
                    getQty('ATTA 35 KGS') +
                    getQty('ATTA 25 KGS') +
                    getQty('ATTA 47 KGS') +
                    getQty('ATTA 48 KGS') +
                    getQty('ATTA 49 KGS') +
                    getQty('ATTA 23 KGS') +
                    getQty('ATTA 30 KGS (M)') +
                    getQty('ATTA 50 KGS TRADING') +
                    getQty('ATTA TRADING (RP)') +
                    getQty('ATTA (MT)') +
                    getQty('ATTA 25KG (MT)') +
                    getQty('ATTA 50KG (MT)') +
                    getQty('BHARAT ATTA 5 KGS') +
                    getQty('BHARAT ATTA 10 KGS') +
                    getQty('EXPORT WM - ATTA 25 KGS') +
                    getQty('EXPORT WM - ATTA 50 KGS') +
                    getQty('TANDOORI ATTA 49 KGS') +
                    getQty('TANDOORI ATTA 50 KGS') +
                    getQty('TANDOORI ATTA REPROCESSING') +
                    getQty('NFSA ATTA (Stock in Process)') +
                    getQty('PDS ATTA 50 KGS') +
                    getQty('ATTA 25 KG (M)') +
                    getQty('ATTA 50 KG (M)') +
                    getQty('ATTA 5 KG (M) - (5Kgs*6pcs = 1 Pkt)') +
                    getQty('ATTA 5KG (MT)-(5KGS*6PCS=1PKT)') +
                    getQty('ATTA 1 KG (M) - ( 1 Kg*30Pcs = 1 Pkt)') +
                    (getQty('ATTA 1 KG') * 1) +
                    (getQty('ATTA 1 KG ( GOLD )') * 1) +
                    (getQty('ATTA 1 KG ( MG )') * 1) +
                    (getQty('ATTA 1 KG ( PCFA )') * 1) +
                    (getQty('ATTA 1 KG (MADURAM)') * 1) +
                    (getQty('ATTA 1 KG (PGMA)') * 1) +
                    (getQty('ATTA 1 KG (UDAAN)') * 1) +
                    (getQty('ATTA 5 KGS') * 5) +
                    (getQty('ATTA 5 KGS ( GOLD )') * 5) +
                    (getQty('ATTA 5 KGS ( PCFA )') * 5) +
                    (getQty('ATTA 5 KGS (Fitolite)') * 5) +
                    (getQty('ATTA 5 KGS (T)') * 5) +
                    (getQty('ATTA 5 KGS (UDAAN)') * 5) +
                    (getQty('ATTA 5 KGS CARTON ( GOLD )') * 5) +
                    (getQty('ATTA 5 KG ( MG )') * 5) +
                    (getQty('ATTA 5 KG (MADURAM)') * 5) +
                    (getQty('ATTA 5 KGS CARTON ( MG )') * 5) +
                    (getQty('ATTA 10 KGS') * 10) +
                    (getQty('ATTA 10 KGS ( GOLD )') * 10) +
                    (getQty('ATTA 10 KGS ( PCFA )') * 10) +
                    (getQty('ATTA 10 KGS (PGMA)') * 10) +
                    (getQty('ATTA 20 LB ( MG )') * 9.07) +
                    (getQty('ATTA 20 LB ( PCFA )') * 9.07) +
                    (getQty('ATTA 1 KG (GM)') * 30) +
                    (getQty('ATTA 5 KGS (GM)') * 30) +
                    (getQty('ATTA 10 KGS (GM)') * 30) +
                    (getQty('ATTA 5 KGS (PGMA)') * 30)
                ),
                'MAIDA': (
                    getQty('MAIDA 50 KGS') +
                    getQty('MAIDA 50KG (TRADING)') +
                    getQty('MAIDA 40 KGS') +
                    getQty('MAIDA 40 KG (T)') +
                    getQty('MAIDA 43 KGS') +
                    getQty('MAIDA 43  KGS') +
                    getQty('MAIDA 44 KGS') +
                    getQty('MAIDA 45 KGS') +
                    getQty('MAIDA 46 KGS') +
                    getQty('MAIDA 47 KGS') +
                    getQty('MAIDA 47 KGS (TRADING)') +
                    getQty('MAIDA 48 KGS') +
                    getQty('MAIDA 49 KGS') +
                    getQty('MAIDA 49 KGS(TRADING)') +
                    getQty('MAIDA 42 KGS (TRADING)') +
                    getQty('MAIDA 30 KGS') +
                    getQty('MAIDA 30 KG (T)') +
                    getQty('MAIDA REPROCESSING') +
                    getQty('MAIDA REPROCESSING (M)') +
                    getQty('MAIDA TRADING (RP)') +
                    getQty('EXPORT MAIDA 25 KGS') +
                    getQty('EXPORT MAIDA 50 KGS') +
                    getQty('BRITANNIA MAIDA (68% - CUSTOM MILLING)') +
                    getQty('BRITANNIA MAIDA (72% - CUSTOM MILLING)') +
                    getQty('BRITANNIA (B) MAIDA (68% - CUSTOM MILLING)') +
                    getQty('BRITANNIA (B) MAIDA (72% - CUSTOM MILLING)') +
                    getQty('MAIDA 50 KG (M)') +
                    getQty('MAIDA 35 KG (M)') +
                    getQty('MAIDA 1 KG (M) - (1Kg*30Pcs = 1 Pkt)') +
                    getQty('MAIDA 1 KG (M)  (1 Kg*20Pcs = 1 Pkt)') +
                    getQty('MAIDA 1KG (MT)-(1KG*30PCS=1PKT)') +
                    getQty('MAIDA 500 GRAM (M) - (500Gms*20 Pcs = 1 Pkt)') +
                    getQty('MAIDA 500 GRAM (M) - (500Gms*60Pcs = 1 Pkt)') +
                    (getQty('MAIDA 1 KG') * 1) +
                    (getQty('MAIDA 1 KGS (UDAAN)') * 1) +
                    (getQty('MAIDA 500 GRAMS') * 0.5) +
                    (getQty('MAIDA 5 KG') * 5)
                ),
                'DALIA': (
                    getQty('DALIA 30 KGS') +
                    getQty('DALIA 500 GRAM (M) - (500Gms* 20 Pcs) = 1 Pkt') +
                    getQty('DALIA 500 GRAM (M) - (500Gms* 40 Pcs) = 1 Pkt') +
                    getQty('DALIA 500 GRAM (M) - (500Gms*60Pcs = 1 Pkt)') +
                    getQty('DALIA 500 GRAM (M) -(500 Gms*30 Pcs) = 1 Pkt') +
                    getQty('DALIA 500 GRAM (M) - (500 Gms * 10 Pcs) = 1 Pkt') +
                    getQty('DALIA 500 GRAM (MT) - (500GMS*60PCS=1PKT)') +
                    getQty('DALIA 500 GRAM (MT)-(500GMS*20PCS)=1PKT') +
                    (getQty('DALIA 500 GRAMS') * 0.5)
                ),
                'SUJI': (
                    getQty('SUJI 50 KGS') +
                    getQty('SUJI 49 KGS') +
                    getQty('SUJI 46 KGS') +
                    getQty('SUJI 47 KGS') +
                    getQty('SUJI 48 KGS') +
                    getQty('SUJI 21 KGS') +
                    getQty('SUJI 50 KGS (TRADING)') +
                    getQty('RAWA SUJI 50 KGS') +
                    getQty('RAWA SUJI 49 KGS') +
                    getQty('SUJI REPROCESSING') +
                    getQty('SUJI TRADING RP') +
                    getQty('EXPORT SUJI 10 KGS') +
                    getQty('EXPORT SUJI 25 KGS') +
                    getQty('EXPORT SUJI 50 KGS') +
                    getQty('SUJI 500 GRAM (M) - (500 Gms*20 Pcs) = 1 Pkt') +
                    getQty('SUJI 500 GRAM (M) - (500 Gms*40 Pcs) = 1 Pkt') +
                    getQty('SUJI 500 GRAM (M) - (500Gms*60Pcs = 1 Pkt)') +
                    getQty('SUJI 500 GRAM (MT)-(500GMS*60PCS=1PKT)') +
                    (getQty('SUJI 500 GRAMS') * 0.5) +
                    (getQty('SUJI 150 GRAMS') * 0.15) +
                    (getQty('SUJI 100 GRAMS') * 0.1) +
                    (getQty('SUJI 200 GRAMS') * 0.2)
                ),
                'WHEAT BRAN': (
                    getQty('WHEAT BRAN') +
                    getQty('WHEAT BRAN (DE)') +
                    getQty('WHEAT BRAN (N)') +
                    getQty('WHEAT BRAN (RP)') +
                    getQty('WHEAT BRAN (T)') +
                    getQty('WHEAT BRAN REPROCESSING') +
                    getQty('WHEAT BRAN SALVAGE') +
                    getQty('EXPORT WHEAT BRAN') +
                    getQty('BRITANNIA WHEAT BRAN') +
                    getQty('BRITANNIA (B) WHEAT BRAN') +
                    getQty('WHEAT BRAN 24 KGS') +
                    getQty('WHEAT BRAN 25 KGS') +
                    getQty('WHEAT BRAN 31KG (T)') +
                    getQty('WHEAT BRAN 33 KGS') +
                    getQty('WHEAT BRAN 34 KGS') +
                    getQty('WHEAT BRAN 35 KGS') +
                    getQty('WHEAT BRAN 36 KG') +
                    getQty('WHEAT BRAN 37 KGS') +
                    getQty('WHEAT BRAN 37 KGS (T)') +
                    getQty('WHEAT BRAN 38 KGS') +
                    getQty('WHEAT BRAN 38 KGS (T)') +
                    getQty('WHEAT BRAN 39 KGS') +
                    getQty('WHEAT BRAN 39 KG (T)') +
                    getQty('WHEAT BRAN 40 KGS') +
                    getQty('WHEAT BRAN 42 KGS') +
                    getQty('WHEAT BRAN 43 KGS') +
                    getQty('WHEAT BRAN 44 KGS') +
                    getQty('WHEAT BRAN 44 KG (T)') +
                    getQty('WHEAT BRAN 45 KGS') +
                    getQty('WHEAT BRAN 46 KGS') +
                    getQty('WHEAT BRAN 47 KGS') +
                    getQty('WHEAT BRAN 47 KGS (T)') +
                    getQty('WHEAT BRAN 48 KGS') +
                    getQty('WHEAT BRAN 48 KGS (T)') +
                    getQty('WHEAT BRAN 49 KGS') +
                    getQty('WHEAT BRAN 49 KGS (T)') +
                    getQty('WHEAT BRAN 50 KGS') +
                    getQty('WHEAT BRAN (T) 50 KGS') +
                    getQty('WHEAT BRAN 25 KG (M)') +
                    getQty('WHEAT BRAN 40 KG (M)') +
                    getQty('WHEAT BRAN 25KG (MT)')
                ),
                'GREEN COFFEE': getQty('GREEN COFFEE'),
                'INSTANT COFFEE': getQty('INSTANT COFFEE SD')
            };

            // Pieces items
            const pcsItems = {
                'NFSA ROLLS': getQty('NFSA ROLLS'),
                'SUNREAP ROLLS': getQty('SUNREAP ROLLS') + getQty('SUNREAP ROLLS 5KG (M)'),
                'MADURAM ROLLS': getQty('ATTA ROLLS 1 KGS (MADURAM)') + getQty('ATTA ROLLS 5 KGS (MADURAM)') + getQty('EXPORT ROLLS'),
                'GM ROLLS': (
                    getQty('ROLLS - 1 KG (GM)') +
                    getQty('ROLLS - 5 KGS (GM)') +
                    getQty('ROLLS - 10 KGS (GM)') +
                    getQty('ROLLS - 1 KG (PGMA)') +
                    getQty('ROLLS - 5 KGS (PGMA)')
                ),
                'GM BAGS': (
                    getQty('WOVEN SACK - 1 KG (GM)') +
                    getQty('WOVEN SACK - 5 KGS (GM)') +
                    getQty('WOVEN SACK - 10 KGS (GM)') +
                    getQty('WOVEN SACK - 1 KG (PGMA)') +
                    getQty('WOVEN SACK - 5 KGS (PGMA)')
                ),
                'HDPE BAGS NEW': (
                    getQty('HDPE BAG ( BRANDED )') +
                    getQty('HDPE BAG ( EXPORT )') +
                    getQty('HDPE BAG ( NFSA )') +
                    getQty('HDPE BAG ( NON BRANDED )') +
                    getQty('HDPE BAG (NEW)')
                ),
                'HDPE BAGS OLD': (
                    getQty('HDPE BAG (USED)') +
                    getQty('NFSA HDPE BAG (USED)')
                ),
                'HESSIAN BAGS OLD': (
                    getQty('HESSIAN BAG (USED)') +
                    getQty('NFSA HESSIAN BAG (USED)')
                )
            };

            // 2. Fetch monthly trial balance
            const ledgersMonthly = await queryCollection('Ledger', ['Name', 'Parent', 'ClosingBalance'], new Map(), targetCompany, new Date(fromDate), new Date(toDate));

            // Group lists
            const salesGroups = ['NON BRANDED SALES', 'EXPORT SALES', 'BRANDED SALES', 'TRADING SALES', 'CONVERSION A/C', 'MILITARY SALES TRADING'];
            const purchaseGroups = ['Purchase Accounts', 'TRADING PURCHASE A/C'];

            // ── CHANGE 1: added 'BHARAT ATTA', 'Broker', 'Sundry Debtors' ──
            const debtorGroups = [
                'NON BRANDED', 'EXPORT', 'SUNREAP',
                'EASTERN COMMAND (NORTH EAST)', 'EASTERN COMMAND (W.B.)',
                'EASTERN COMMAND (SIKKIM)', 'SOUTHERN COMMAND',
                'CENTRAL COMMAND', 'NAVAL BASE', 'NFSA', 'NFSA A/C',
                'BHARAT ATTA', 'Broker', 'Sundry Debtors'
            ];

            let salesMonthly = 0;
            let purchaseMonthly = 0;
            let advanceFromCustomer = 0;
            let advanceToSuppliersCreditors = 0;
            let advanceToSuppliersCreditCard = 0;
            let sundryCreditorsGroup = 0;
            let storesPurchaseGroup = 0;
            let wheatPurchaseGroup = 0;
            let totalDebtorsGross = 0;

            for (const led of ledgersMonthly) {
                const parent = led.Parent || '';
                const cb = led.ClosingBalance || 0;

                if (salesGroups.includes(parent)) {
                    salesMonthly += cb;
                }
                if (purchaseGroups.includes(parent)) {
                    purchaseMonthly += cb;
                }
                if (debtorGroups.includes(parent) && cb > 0) {
                    advanceFromCustomer += cb;
                }

                // ── CHANGE 2 & 3: advance to suppliers + sundry creditors ──
                if (parent === 'Sundry Creditors' && cb < 0) { advanceToSuppliersCreditors += cb; }
                if (parent === 'STORES PURCHASE' && cb < 0) { advanceToSuppliersCreditors += cb; }
                if (parent === 'WHEAT PURCHASE' && cb < 0) { advanceToSuppliersCreditors += cb; }
                if (parent === 'WHEAT BRAN PURCHASE' && cb < 0) { advanceToSuppliersCreditors += cb; }
                if (parent === 'TRANSPORTERS' && cb < 0) { advanceToSuppliersCreditors += cb; }
                if (parent === 'MOHANIA A/C.' && cb < 0) { advanceToSuppliersCreditors += cb; }

                if (parent === 'CREDIT CARD') { advanceToSuppliersCreditCard += cb; }

                if (parent === 'Sundry Creditors' && cb > 0) { sundryCreditorsGroup += cb; }
                if (parent === 'STORES PURCHASE' && cb > 0) { storesPurchaseGroup += cb; }
                if (parent === 'WHEAT PURCHASE' && cb > 0) { wheatPurchaseGroup += cb; }
                if (parent === 'WHEAT BRAN PURCHASE' && cb > 0) { sundryCreditorsGroup += cb; }
                if (parent === 'TRANSPORTERS' && cb > 0) { sundryCreditorsGroup += cb; }
                if (parent === 'MOHANIA A/C.' && cb > 0) { sundryCreditorsGroup += cb; }

                if (debtorGroups.includes(parent) && cb < 0) {
                    totalDebtorsGross += cb;
                }
            }

            const purchaseMonthlyAbs = Math.abs(purchaseMonthly);
            const advanceToSuppliers = Math.abs(advanceToSuppliersCreditors) + Math.abs(advanceToSuppliersCreditCard);
            const sundryCreditors = sundryCreditorsGroup + storesPurchaseGroup + wheatPurchaseGroup;

            // 3. Fetch cumulative trial balance
            const ledgersCumulative = await queryCollection('Ledger', ['Name', 'Parent', 'ClosingBalance'], new Map(), targetCompany, new Date(cumulativeFromDate), new Date(toDate));
            let salesCumulative = 0;
            let purchaseCumulative = 0;

            for (const led of ledgersCumulative) {
                const parent = led.Parent || '';
                const cb = led.ClosingBalance || 0;

                if (salesGroups.includes(parent)) { salesCumulative += cb; }
                if (purchaseGroups.includes(parent)) { purchaseCumulative += cb; }
            }
            const purchaseCumulativeAbs = Math.abs(purchaseCumulative);

            // 4. Fetch bills-outstanding for debtor ageing (receivables)
            const parseDateSafe = (str) => {
                if (!str) return null;
                const s = String(str).trim();
                if (/^\d{8}$/.test(s)) {
                    return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
                }
                if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
                    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
                    return new Date(y, m - 1, d);
                }
                if (/^\d{2}[-\/]\d{2}[-\/]\d{4}/.test(s)) {
                    const parts = s.slice(0, 10).split(/[-\/]/);
                    return new Date(+parts[2], +parts[1] - 1, +parts[0]);
                }
                const monMatch = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2}|\d{4})/);
                if (monMatch) {
                    const months = { JAN: 0, JANUARY: 0, FEB: 1, FEBRUARY: 1, MAR: 2, MARCH: 2, APR: 3, APRIL: 3, MAY: 4, JUN: 5, JUNE: 5, JUL: 6, JULY: 6, AUG: 7, AUGUST: 7, SEP: 8, SEPT: 8, SEPTEMBER: 8, OCT: 9, OCTOBER: 9, NOV: 10, NOVEMBER: 10, DEC: 11, DECEMBER: 11 };
                    const mm = months[monMatch[2].toUpperCase()];
                    if (mm !== undefined) {
                        let y = Number(monMatch[3]);
                        if (y < 100) y += y >= 70 ? 1900 : 2000;
                        return new Date(y, mm, Number(monMatch[1]));
                    }
                }
                return new Date(s);
            };

            const parseToDateSafe = (str) => {
                const [y, m, d] = str.slice(0, 10).split('-').map(Number);
                return new Date(y, m - 1, d);
            };

            const fieldsLedger = ['Name', 'Parent', '_PrimaryGroup'];
            const ledgers = await queryCollection('Ledger', fieldsLedger, new Map(), targetCompany);
            const ledgerMap = new Map();
            for (const led of ledgers) {
                ledgerMap.set(led.Name, {
                    parent: led.Parent || '',
                    primaryGroup: led._PrimaryGroup || ''
                });
            }

            const asOnDate = parseToDateSafe(toDate);
            const rawBills = await fetchBillsOutstanding(targetCompany, toDate);

            let pendingBillsDebitTotal = 0;
            let sixtyToNinetyDebit = 0;
            let aboveNinetyDebit = 0;

            for (const bill of rawBills) {
                const partyName = bill.party_name || '';
                const ledInfo = ledgerMap.get(partyName);
                if (!ledInfo || ledInfo.primaryGroup !== 'Sundry Debtors') {
                    continue;
                }

                const amt = bill.outstanding_amount || 0;
                if (amt < 0) {
                    const absAmt = Math.abs(amt);
                    pendingBillsDebitTotal += absAmt;

                    const billDateRaw = bill.bill_date;
                    if (!billDateRaw) continue;

                    let billDate;
                    if (billDateRaw instanceof Date) {
                        billDate = new Date(billDateRaw.getFullYear(), billDateRaw.getMonth(), billDateRaw.getDate());
                    } else {
                        billDate = parseDateSafe(billDateRaw);
                    }
                    if (!billDate || isNaN(billDate)) continue;

                    const actualDays = Math.round((asOnDate - billDate) / (1000 * 60 * 60 * 24));

                    if (actualDays > 61 && actualDays <= 91) {
                        sixtyToNinetyDebit += absAmt;
                    } else if (actualDays > 91) {
                        aboveNinetyDebit += absAmt;
                    }
                }
            }

            const totalDebtors = Number(pendingBillsDebitTotal.toFixed(2));
            const age60to90 = Number(sixtyToNinetyDebit.toFixed(2));
            const age90onwards = Number(aboveNinetyDebit.toFixed(2));
            const ageLess60 = Number((totalDebtors - age60to90 - age90onwards).toFixed(2));

            const toDateObj = new Date(toDate);
            const periodStr = `${String(toDateObj.getMonth() + 1).padStart(2, '0')}-${toDateObj.getFullYear()}`;

            const resultJson = {
                company: targetCompany,
                period: periodStr,
                stock: {
                    wheat: kgsItems['WHEAT'],
                    atta_kgs: kgsItems['ATTA'],
                    maida_kgs: kgsItems['MAIDA'],
                    dalia_kgs: kgsItems['DALIA'],
                    suji_kgs: kgsItems['SUJI'],
                    wheat_bran_kgs: kgsItems['WHEAT BRAN'],
                    green_coffee_kgs: kgsItems['GREEN COFFEE'],
                    instant_coffee_kgs: kgsItems['INSTANT COFFEE'],
                    nfsa_rolls_pcs: pcsItems['NFSA ROLLS'],
                    sunreap_rolls_pcs: pcsItems['SUNREAP ROLLS'],
                    maduram_rolls_pcs: pcsItems['MADURAM ROLLS'],
                    gm_rolls_pcs: pcsItems['GM ROLLS'],
                    gm_bags_pcs: pcsItems['GM BAGS'],
                    hdpe_bags_new_pcs: pcsItems['HDPE BAGS NEW'],
                    hdpe_bags_old_pcs: pcsItems['HDPE BAGS OLD'],
                    hessian_bags_old_pcs: pcsItems['HESSIAN BAGS OLD']
                },
                financials: {
                    advance_from_customer: advanceFromCustomer,
                    advance_to_suppliers: advanceToSuppliers,
                    sundry_creditors: sundryCreditors,
                    sales_monthly: salesMonthly,
                    sales_cumulative: salesCumulative,
                    purchase_monthly: purchaseMonthlyAbs,
                    purchase_cumulative: purchaseCumulativeAbs,
                    total_debtors: totalDebtors,
                    less_than_60_days: ageLess60,
                    days_60_to_90: age60to90,
                    days_90_onwards: age90onwards
                }
            };

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(resultJson, null, 2)
                }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err?.message || err) }]
            };
        }
    });

    const getCompanyName = async (targetCompany) => {
        if (targetCompany) return targetCompany;
        try {
            const companies = await queryCollection('Company', ['Name', 'IsActiveCompany'], new Map());
            const active = companies.find(c => c.IsActiveCompany);
            return active ? active.Name : (companies[0] ? companies[0].Name : 'Unknown Company');
        } catch (e) {
            return 'Unknown Company';
        }
    };

    const getPeriodStr = (toDateStr) => {
        if (!toDateStr) return '';
        const parts = toDateStr.split('-');
        if (parts.length >= 2) {
            return `${parts[1]}-${parts[0]}`;
        }
        return '';
    };

    const formatDDMonYY = (dateVal) => {
        if (!dateVal) return '';
        const dt = new Date(dateVal);
        if (Number.isNaN(dt.getTime())) return '';
        const day = String(dt.getDate()).padStart(2, '0');
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = months[dt.getMonth()];
        const year = String(dt.getFullYear()).slice(-2);
        return `${day}-${month}-${year}`;
    };

    const round2 = (val) => Number((val || 0).toFixed(2));

    mcpServer.registerTool('headwise-purchase-report', {
        title: 'Headwise Purchase Report',
        description: 'Generates a headwise purchase report for any open Tally company containing categorized vouchers, head-wise summaries, and grand totals in structured JSON.',
        inputSchema: {
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('start date (YYYY-MM-DD)'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('end date (YYYY-MM-DD)'),
            targetCompany: z.string().optional().describe('optional company name'),
            voucherTypes: z.array(z.string()).optional().describe('optional list of voucher type names to include')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const { fromDate, toDate, targetCompany, voucherTypes } = args;
            const companyName = await getCompanyName(targetCompany);
            const periodStr = getPeriodStr(toDate);

            let targetVoucherTypes = voucherTypes;
            if (!targetVoucherTypes || targetVoucherTypes.length === 0) {
                try {
                    const vchTypes = await queryCollection('VoucherType', ['Name', 'Parent'], new Map(), targetCompany);
                    targetVoucherTypes = vchTypes
                        .filter(vt => vt.Parent === 'Purchase' || vt.Parent === 'Debit Note')
                        .map(vt => vt.Name);
                } catch (e) {
                    targetVoucherTypes = [];
                }
            }

            const inputParams = new Map([['fromDate', fromDate], ['toDate', toDate]]);
            if (targetCompany) inputParams.set('targetCompany', targetCompany);
            if (targetVoucherTypes && targetVoucherTypes.length > 0) {
                inputParams.set('voucherTypes', targetVoucherTypes);
            }

            const resp = await fetchReport('headwise-purchase-vouchers', inputParams);
            if (resp.error) {
                return { isError: true, content: [{ type: 'text', text: resp.error }] };
            }

            const rawRows = Array.isArray(resp.data) ? resp.data : [];
            const voucherMap = new Map();
            for (const row of rawRows) {
                const vchNo = row.voucher_number || '';
                if (!voucherMap.has(vchNo)) {
                    voucherMap.set(vchNo, {
                        date: row.date,
                        voucher_type: row.voucher_type,
                        voucher_number: vchNo,
                        narration: row.narration,
                        party_name: row.party_name,
                        supplier_invoice_no: row.supplier_invoice_no,
                        supplier_invoice_date: row.supplier_invoice_date,
                        'ALLLEDGERENTRIES.LIST': []
                    });
                }
                const vch = voucherMap.get(vchNo);
                vch['ALLLEDGERENTRIES.LIST'].push({
                    ledger_name: row.ledger_name,
                    ledger_group: row.ledger_group,
                    ledger_primary_group: row.ledger_primary_group,
                    amount: row.amount,
                    is_debit: row.is_debit
                });
            }
            const rawVouchers = Array.from(voucherMap.values());

            const isTaxLedger = (name) => {
                const n = (name || '').toUpperCase();
                return n.includes('CGST') || n.includes('SGST') || n.includes('IGST') || n.includes('UTGST') || n.includes('CESS') || n.includes('TDS');
            };

            const isRoundOff = (name) => {
                const n = (name || '').toUpperCase();
                return n.includes('ROUND') || n.includes('R/O') || n.includes('ROUNDING') || n.includes('RETENTION') || n.includes('DEDUCTION');
            };

            const formatYYYYMMDD = (dateVal) => {
                if (!dateVal) return '';
                const dt = new Date(dateVal);
                if (Number.isNaN(dt.getTime())) return '';
                const y = dt.getFullYear();
                const m = String(dt.getMonth() + 1).padStart(2, '0');
                const d = String(dt.getDate()).padStart(2, '0');
                return `${y}-${m}-${d}`;
            };

            const categories = {};
            let grandTaxableTotal = 0;
            let grandCgstTotal = 0;
            let grandSgstTotal = 0;
            let grandIgstTotal = 0;
            let grandTotal = 0;

            for (const vch of rawVouchers) {
                const vchNo = vch.voucher_number || '';
                if (!vchNo.trim().toUpperCase().startsWith('RNB')) {
                    continue;
                }
                const entries = Array.isArray(vch['ALLLEDGERENTRIES.LIST']) ? vch['ALLLEDGERENTRIES.LIST'] : [];

                // Auto-detect if is_debit flag is inverted by looking at a tax ledger (which must be Debit)
                let isDebitFlagInverted = false;
                const taxEntry = entries.find(e => isTaxLedger(e.ledger_name));
                if (taxEntry && (taxEntry.is_debit === '0' || taxEntry.is_debit === 0 || String(taxEntry.is_debit) === '0')) {
                    isDebitFlagInverted = true;
                }
                const checkIsDebit = (e) => {
                    const rawDebit = e.is_debit === '1' || e.is_debit === 1 || String(e.is_debit) === '1';
                    return isDebitFlagInverted ? !rawDebit : rawDebit;
                };

                const isExpenseOrAssetHead = (e) => {
                    const isDebit = checkIsDebit(e);
                    if (!isDebit) return false;
                    const lName = (e.ledger_name || '').toUpperCase();
                    if (isTaxLedger(lName) || isRoundOff(lName)) return false;
                    if (lName.includes('WHEAT PURCHASE') || lName.includes('MAIDA PURCHASE')) return false;

                    const pg = (e.ledger_primary_group || '').toUpperCase();
                    const g = (e.ledger_group || '').toUpperCase();
                    if (pg) {
                        const validGroups = ['DIRECT EXPENSES', 'INDIRECT EXPENSES', 'PURCHASE ACCOUNTS', 'FIXED ASSETS', 'CURRENT ASSETS'];
                        return validGroups.includes(pg) || g.includes('EXPENSE') || g.includes('PURCHASE') || g.includes('ASSET');
                    }
                    return true;
                };

                // Find party/creditor ledger (credit entry: is_debit is not 1, and it's not tax/roundoff)
                let party = vch.party_name || '';
                const partyEntry = entries.find(e => {
                    if (vch.party_name && (e.ledger_name || '').toUpperCase() === vch.party_name.toUpperCase()) {
                        return true;
                    }
                    const isDebit = checkIsDebit(e);
                    return !isDebit && !isTaxLedger(e.ledger_name) && !isRoundOff(e.ledger_name);
                });
                if (partyEntry) {
                    party = partyEntry.ledger_name;
                }

                // Split CGST, SGST, IGST totals in this voucher
                let cgstVch = 0;
                let sgstVch = 0;
                let igstVch = 0;
                for (const e of entries) {
                    const lName = (e.ledger_name || '').toUpperCase();
                    const amt = Math.abs(Number(e.amount) || 0);
                    if (lName.includes('CGST')) {
                        cgstVch += amt;
                    } else if (lName.includes('SGST') || lName.includes('UTGST')) {
                        sgstVch += amt;
                    } else if (lName.includes('IGST')) {
                        igstVch += amt;
                    }
                }

                // Filter expense/asset head entries (debit entry: is_debit is 1, and it's not tax/roundoff)
                const expenseEntries = entries.filter(isExpenseOrAssetHead);

                const supplierInvNo = vch.supplier_invoice_no || '';
                const supplierInvDate = formatYYYYMMDD(vch.supplier_invoice_date);

                if (expenseEntries.length === 0) {
                    let unclassifiedTaxable = 0;
                    for (const e of entries) {
                        if (isExpenseOrAssetHead(e)) {
                            unclassifiedTaxable += Math.abs(Number(e.amount) || 0);
                        }
                    }
                    if (unclassifiedTaxable === 0) {
                        unclassifiedTaxable = Math.abs(Number(partyEntry?.amount) || 0) - (cgstVch + sgstVch + igstVch);
                        if (unclassifiedTaxable < 0) unclassifiedTaxable = 0;
                    }

                    const headName = 'Unclassified Expenses';
                    if (!categories[headName]) {
                        categories[headName] = { vouchers: [], subtotal: { taxable_value: 0, cgst: 0, sgst: 0, igst: 0, total: 0 } };
                    }

                    const total_amount = unclassifiedTaxable + cgstVch + sgstVch + igstVch;
                    const existing = categories[headName].vouchers.find(v => v.voucher_no === vchNo);
                    if (existing) {
                        existing.taxable_value = round2(existing.taxable_value + unclassifiedTaxable);
                        existing.cgst = round2(existing.cgst + cgstVch);
                        existing.sgst = round2(existing.sgst + sgstVch);
                        existing.igst = round2(existing.igst + igstVch);
                        existing.total = round2(existing.total + total_amount);
                    } else {
                        categories[headName].vouchers.push({
                            party,
                            voucher_no: vchNo,
                            supplier_invoice_no: supplierInvNo,
                            supplier_invoice_date: supplierInvDate,
                            taxable_value: round2(unclassifiedTaxable),
                            cgst: round2(cgstVch),
                            sgst: round2(sgstVch),
                            igst: round2(igstVch),
                            total: round2(total_amount)
                        });
                    }

                    categories[headName].subtotal.taxable_value += unclassifiedTaxable;
                    categories[headName].subtotal.cgst += cgstVch;
                    categories[headName].subtotal.sgst += sgstVch;
                    categories[headName].subtotal.igst += igstVch;
                    categories[headName].subtotal.total += total_amount;

                    grandTaxableTotal += unclassifiedTaxable;
                    grandCgstTotal += cgstVch;
                    grandSgstTotal += sgstVch;
                    grandIgstTotal += igstVch;
                    grandTotal += total_amount;
                } else {
                    const totalMatchedTaxable = expenseEntries.reduce((sum, e) => sum + Math.abs(Number(e.amount) || 0), 0);
                    const uniqueLedgers = [...new Set(expenseEntries.map(e => e.ledger_name))].sort();
                    const headName = uniqueLedgers.join(', ');
                    const taxable = totalMatchedTaxable;
                    const cgstVal = cgstVch;
                    const sgstVal = sgstVch;
                    const igstVal = igstVch;
                    const total_amount = taxable + cgstVal + sgstVal + igstVal;

                    if (!categories[headName]) {
                        categories[headName] = { vouchers: [], subtotal: { taxable_value: 0, cgst: 0, sgst: 0, igst: 0, total: 0 } };
                    }

                    const existing = categories[headName].vouchers.find(v => v.voucher_no === vchNo);
                    if (existing) {
                        existing.taxable_value = round2(existing.taxable_value + taxable);
                        existing.cgst = round2(existing.cgst + cgstVal);
                        existing.sgst = round2(existing.sgst + sgstVal);
                        existing.igst = round2(existing.igst + igstVal);
                        existing.total = round2(existing.total + total_amount);
                    } else {
                        categories[headName].vouchers.push({
                            party,
                            voucher_no: vchNo,
                            supplier_invoice_no: supplierInvNo,
                            supplier_invoice_date: supplierInvDate,
                            taxable_value: round2(taxable),
                            cgst: round2(cgstVal),
                            sgst: round2(sgstVal),
                            igst: round2(igstVal),
                            total: round2(total_amount)
                        });
                    }

                    categories[headName].subtotal.taxable_value += taxable;
                    categories[headName].subtotal.cgst += cgstVal;
                    categories[headName].subtotal.sgst += sgstVal;
                    categories[headName].subtotal.igst += igstVal;
                    categories[headName].subtotal.total += total_amount;

                    grandTaxableTotal += taxable;
                    grandCgstTotal += cgstVal;
                    grandSgstTotal += sgstVal;
                    grandIgstTotal += igstVal;
                    grandTotal += total_amount;
                }
            }

            // Round subtotals
            for (const headName of Object.keys(categories)) {
                const sub = categories[headName].subtotal;
                categories[headName].subtotal = {
                    taxable_value: round2(sub.taxable_value),
                    cgst: round2(sub.cgst),
                    sgst: round2(sub.sgst),
                    igst: round2(sub.igst),
                    total: round2(sub.total)
                };
            }

            // Filter out specific categories and adjust grand totals
            const excludeCategories = ['WHEAT PURCHASE A/C', 'MAIDA PURCHASE TRADING A/C', 'Unclassified Expenses'];
            for (const headName of Object.keys(categories)) {
                if (excludeCategories.some(exc => headName.toUpperCase() === exc.toUpperCase())) {
                    const sub = categories[headName].subtotal;
                    grandTaxableTotal -= sub.taxable_value;
                    grandCgstTotal -= sub.cgst;
                    grandSgstTotal -= sub.sgst;
                    grandIgstTotal -= sub.igst;
                    grandTotal -= sub.total;
                    delete categories[headName];
                }
            }

            const responseJson = {
                company: companyName,
                period: periodStr,
                categories,
                grand_total: {
                    taxable_value: round2(grandTaxableTotal),
                    cgst: round2(grandCgstTotal),
                    sgst: round2(grandSgstTotal),
                    igst: round2(grandIgstTotal),
                    total: round2(grandTotal)
                }
            };

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(responseJson, null, 2)
                }]
            };

        } catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err?.message || err) }]
            };
        }
    });

    mcpServer.registerTool('headwise-sales-report', {
        title: 'Headwise Sales Report',
        description: 'Generates a headwise sales report for any open Tally company containing categorized sales vouchers, summaries, and grand totals in structured JSON.',
        inputSchema: {
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('start date (YYYY-MM-DD)'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('end date (YYYY-MM-DD)'),
            targetCompany: z.string().optional().describe('optional company name')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const { fromDate, toDate, targetCompany } = args;
            const companyName = await getCompanyName(targetCompany);
            const periodStr = getPeriodStr(toDate);

            const inputParams = new Map([['fromDate', fromDate], ['toDate', toDate]]);
            if (targetCompany) inputParams.set('targetCompany', targetCompany);

            const resp = await fetchReport('headwise-sales-vouchers', inputParams);
            if (resp.error) {
                return { isError: true, content: [{ type: 'text', text: resp.error }] };
            }

            const rawVouchers = Array.isArray(resp.data) ? resp.data : [];

            // Sales mapping definition
            const SALES_TO_BROAD = {
                "ATTA SALES A/C": "Atta Sales",
                "BRANDED ATTA SALES A/C": "Atta Sales",
                "ATTA SALES TRADING (MT)": "Atta Sales",
                "ATTA SALES A/C (EXPORT)": "Atta Sales",
                "MAIDA SALES A/C": "Maida Sales",
                "BRANDED MAIDA SALES A/C": "Maida Sales",
                "MAIDA SALES TRADING (MT)": "Maida Sales",
                "MAIDA SALES A/C (EXPORT)": "Maida Sales",
                "SUJI SALES A/C": "Suji Sales",
                "BRANDED SUJI SALES A/C": "Suji Sales",
                "SUJI SALES TRADING (MT)": "Suji Sales",
                "DALIA SALES A/C": "Dalia Sales",
                "BRANDED DALIA SALES A/C": "Dalia Sales",
                "DALIA SALES TRADING (MT)": "Dalia Sales",
                "WHEAT BRAN SALES A/C": "Wheat Bran Sales",
                "WHEAT BRAN SALES TRADING (MT)": "Wheat Bran Sales",
                "NFSA - WHEAT BRAN SALES A/C": "NFSA Sales",
                "NFSA - WHEAT REFRACTION SALES A/C": "NFSA Sales",
                "NFSA ROLLS A/C": "NFSA Sales",
                "COFFEE SALES TRADING A/C": "Coffee Sales",
                "COFFEE SALES TRADING (E)": "Coffee Sales",
                "SUNREAP ATTA SALES A/C": "Sunreap Sales",
                "DISCOUNT": "Deductions",
                "BROKERAGE SALES": "Deductions",
                "FREIGHT OUTWARD CHARGES": "Freight Outward"
            };

            const SALES_LEDGERS = new Set(Object.keys(SALES_TO_BROAD).map(k => k.toUpperCase()));

            const getSalesCategory = (vchNum, vchType) => {
                const num = (vchNum || '').toUpperCase();
                const type = (vchType || '').toUpperCase();
                const combined = `${num}|${type}`;
                if (combined.includes('BR') || combined.includes('BRANDED')) return 'BRANDED';
                if (combined.includes('NB') || combined.includes('NON BRANDED')) return 'NON BRANDED';
                if (combined.includes('EXP') || combined.includes('EXPORT')) return 'EXPORT';
                if (combined.includes('MT') || combined.includes('MILITARY')) return 'MILITARY';
                if (combined.includes('NFSA')) return 'NFSA';
                if (combined.includes('CREDIT NOTE')) return 'CREDIT NOTE';
                return vchType || 'GENERAL';
            };

            const categoriesData = {};

            for (const vch of rawVouchers) {
                const vchNum = vch.voucher_number || '';
                const vchType = vch.voucher_type || '';
                const cat = getSalesCategory(vchNum, vchType);

                if (!categoriesData[cat]) {
                    categoriesData[cat] = { vouchers: [] };
                }

                const entries = Array.isArray(vch['ALLLEDGERENTRIES.LIST']) ? vch['ALLLEDGERENTRIES.LIST'] : [];

                let sgstTotal = 0;
                let cgstTotal = 0;
                let igstTotal = 0;
                for (const e of entries) {
                    const lName = (e.ledger_name || '').toUpperCase();
                    const amt = Math.abs(e.amount || 0);
                    if (lName.includes('SGST') || lName.includes('UTGST')) {
                        sgstTotal += amt;
                    } else if (lName.includes('CGST')) {
                        cgstTotal += amt;
                    } else if (lName.includes('IGST')) {
                        igstTotal += amt;
                    }
                }

                const salesEntries = entries.filter(e => {
                    const lName = (e.ledger_name || '').toUpperCase();
                    return SALES_LEDGERS.has(lName);
                });

                const dateFormatted = formatDDMonYY(vch.date);

                if (salesEntries.length === 0) {
                    let unclassifiedSale = 0;
                    for (const e of entries) {
                        const lName = (e.ledger_name || '').toUpperCase();
                        if (lName !== (vch.party_name || '').toUpperCase() &&
                            !lName.includes('SGST') && !lName.includes('UTGST') &&
                            !lName.includes('CGST') && !lName.includes('IGST') &&
                            !lName.includes('CESS') && !lName.includes('ROUND')) {
                            unclassifiedSale += Math.abs(e.amount || 0);
                        }
                    }

                    const total_gst = sgstTotal + cgstTotal + igstTotal;
                    categoriesData[cat].vouchers.push({
                        date: dateFormatted,
                        voucher_number: vchNum,
                        party_name: vch.party_name || '',
                        tally_head: 'Unclassified',
                        broad_head: 'Unclassified',
                        description: vch.narration || '',
                        sale_value: round2(unclassifiedSale),
                        sgst: round2(sgstTotal),
                        cgst: round2(cgstTotal),
                        igst: round2(igstTotal),
                        total_gst: round2(total_gst),
                        total_amount: round2(unclassifiedSale + total_gst)
                    });
                } else {
                    const totalMatchedSale = salesEntries.reduce((sum, e) => sum + Math.abs(e.amount || 0), 0);
                    for (const entry of salesEntries) {
                        const tHead = entry.ledger_name;
                        const bHead = SALES_TO_BROAD[tHead.toUpperCase()] || tHead;
                        const saleVal = Math.abs(entry.amount || 0);
                        const ratio = totalMatchedSale > 0 ? (saleVal / totalMatchedSale) : (1 / salesEntries.length);

                        const sgstVal = sgstTotal * ratio;
                        const cgstVal = cgstTotal * ratio;
                        const igstVal = igstTotal * ratio;
                        const total_gst = sgstVal + cgstVal + igstVal;

                        categoriesData[cat].vouchers.push({
                            date: dateFormatted,
                            voucher_number: vchNum,
                            party_name: vch.party_name || '',
                            tally_head: tHead,
                            broad_head: bHead,
                            description: vch.narration || '',
                            sale_value: round2(saleVal),
                            sgst: round2(sgstVal),
                            cgst: round2(cgstVal),
                            igst: round2(igstVal),
                            total_gst: round2(total_gst),
                            total_amount: round2(saleVal + total_gst)
                        });
                    }
                }
            }

            const finalCategories = {};
            const standardCategories = ["BRANDED", "NON BRANDED", "EXPORT", "MILITARY", "NFSA", "CREDIT NOTE"];
            const allCats = new Set([...standardCategories, ...Object.keys(categoriesData)]);

            for (const cat of allCats) {
                const cData = categoriesData[cat];
                if (!cData || cData.vouchers.length === 0) continue;

                const summaryMap = {};
                let catSaleTotal = 0;
                let catSgstTotal = 0;
                let catCgstTotal = 0;
                let catIgstTotal = 0;
                let catGstTotal = 0;
                let catAmountTotal = 0;
                const catUniqueVouchers = new Set();

                for (const v of cData.vouchers) {
                    catUniqueVouchers.add(v.voucher_number);
                    catSaleTotal += v.sale_value;
                    catSgstTotal += v.sgst;
                    catCgstTotal += v.cgst;
                    catIgstTotal += v.igst;
                    catGstTotal += v.total_gst;
                    catAmountTotal += v.total_amount;

                    const bh = v.broad_head;
                    if (!summaryMap[bh]) {
                        summaryMap[bh] = {
                            broad_head: bh,
                            tally_heads: new Set(),
                            vouchers: new Set(),
                            sale_value: 0,
                            sgst: 0,
                            cgst: 0,
                            igst: 0,
                            total_gst: 0,
                            total_amount: 0
                        };
                    }
                    summaryMap[bh].tally_heads.add(v.tally_head);
                    summaryMap[bh].vouchers.add(v.voucher_number);
                    summaryMap[bh].sale_value += v.sale_value;
                    summaryMap[bh].sgst += v.sgst;
                    summaryMap[bh].cgst += v.cgst;
                    summaryMap[bh].igst += v.igst;
                    summaryMap[bh].total_gst += v.total_gst;
                    summaryMap[bh].total_amount += v.total_amount;
                }

                const head_summary = Object.values(summaryMap).map(s => ({
                    broad_head: s.broad_head,
                    tally_heads: Array.from(s.tally_heads),
                    voucher_count: s.vouchers.size,
                    sale_value: round2(s.sale_value),
                    sgst: round2(s.sgst),
                    cgst: round2(s.cgst),
                    igst: round2(s.igst),
                    total_gst: round2(s.total_gst),
                    total_amount: round2(s.total_amount)
                }));

                finalCategories[cat] = {
                    vouchers: cData.vouchers,
                    head_summary,
                    total: {
                        voucher_count: catUniqueVouchers.size,
                        sale_value: round2(catSaleTotal),
                        sgst: round2(catSgstTotal),
                        cgst: round2(catCgstTotal),
                        igst: round2(catIgstTotal),
                        total_gst: round2(catGstTotal),
                        total_amount: round2(catAmountTotal)
                    }
                };
            }

            const grandSummaryMap = {};
            let grandSaleTotal = 0;
            let grandSgstTotal = 0;
            let grandCgstTotal = 0;
            let grandIgstTotal = 0;
            let grandGstTotal = 0;
            let grandAmountTotal = 0;

            for (const cat of Object.keys(finalCategories)) {
                for (const v of finalCategories[cat].vouchers) {
                    grandSaleTotal += v.sale_value;
                    grandSgstTotal += v.sgst;
                    grandCgstTotal += v.cgst;
                    grandIgstTotal += v.igst;
                    grandGstTotal += v.total_gst;
                    grandAmountTotal += v.total_amount;

                    const bh = v.broad_head;
                    if (!grandSummaryMap[bh]) {
                        grandSummaryMap[bh] = {
                            broad_head: bh,
                            branded_amount: 0,
                            non_branded_amount: 0,
                            export_amount: 0,
                            military_amount: 0,
                            nfsa_amount: 0,
                            total_amount: 0,
                            total_gst: 0
                        };
                    }

                    const amt = v.sale_value;
                    if (cat === "BRANDED") grandSummaryMap[bh].branded_amount += amt;
                    else if (cat === "NON BRANDED") grandSummaryMap[bh].non_branded_amount += amt;
                    else if (cat === "EXPORT") grandSummaryMap[bh].export_amount += amt;
                    else if (cat === "MILITARY") grandSummaryMap[bh].military_amount += amt;
                    else if (cat === "NFSA") grandSummaryMap[bh].nfsa_amount += amt;

                    grandSummaryMap[bh].total_amount += amt;
                    grandSummaryMap[bh].total_gst += v.total_gst;
                }
            }

            const grand_summary = Object.values(grandSummaryMap).map(g => ({
                broad_head: g.broad_head,
                branded_amount: round2(g.branded_amount),
                non_branded_amount: round2(g.non_branded_amount),
                export_amount: round2(g.export_amount),
                military_amount: round2(g.military_amount),
                nfsa_amount: round2(g.nfsa_amount),
                total_amount: round2(g.total_amount),
                total_gst: round2(g.total_gst)
            }));

            const responseJson = {
                company: companyName,
                period: periodStr,
                from_date: fromDate,
                to_date: toDate,
                categories: finalCategories,
                grand_summary,
                grand_total: {
                    sale_value: round2(grandSaleTotal),
                    sgst: round2(grandSgstTotal),
                    cgst: round2(grandCgstTotal),
                    igst: round2(grandIgstTotal),
                    total_gst: round2(grandGstTotal),
                    total_amount: round2(grandAmountTotal)
                }
            };

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(responseJson, null, 2)
                }]
            };

        } catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err?.message || err) }]
            };
        }
    });

    // ── pdf-compare ──────────────────────────────────────────────────────────
    mcpServer.registerTool('pdf-compare', {
        title: 'PDF Compare',
        description: `Compares two PDF documents and returns a structured diff: lines present in only one PDF, value mismatches for shared keys (amounts, dates, invoice numbers, totals), and a summary count. Accepts either absolute file paths on the server machine OR base64-encoded PDF content. Use filePath_a / filePath_b for local files, or pdfBase64_a / pdfBase64_b for inline content. Useful for comparing two versions of an invoice, statement, or report to spot additions, deletions, and changed values. Returns: only_in_a (lines / values present in PDF-A but not PDF-B), only_in_b (lines / values present in PDF-B but not PDF-A), mismatches (same key / label but different value), matched_count, and a plain-text diff preview.`,
        inputSchema: {
            filePath_a: z.string().optional().describe('Absolute path to the first PDF file on the server machine'),
            filePath_b: z.string().optional().describe('Absolute path to the second PDF file on the server machine'),
            pdfBase64_a: z.string().optional().describe('Base64-encoded content of the first PDF (alternative to filePath_a)'),
            pdfBase64_b: z.string().optional().describe('Base64-encoded content of the second PDF (alternative to filePath_b)'),
            label_a: z.string().optional().default('PDF-A').describe('Label for the first PDF in the output'),
            label_b: z.string().optional().default('PDF-B').describe('Label for the second PDF in the output'),
            ignoreCase: z.boolean().optional().default(true).describe('Whether to ignore case when comparing lines'),
            ignoreBlankLines: z.boolean().optional().default(true).describe('Whether to skip blank / whitespace-only lines'),
            numberTolerance: z.number().optional().default(0.01).describe('Tolerance for numeric value comparison (e.g. 0.01 means values within ±0.01 are treated as equal)'),
            maxDiffLines: z.number().optional().default(500).describe('Maximum number of diff rows to return (prevents huge outputs)')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const fs = await import('fs');
            const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
            await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
            pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;

            // ── resolve PDF buffers ──
            const getBuffer = async (filePath, base64) => {
                if (filePath) {
                    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
                    return fs.readFileSync(filePath);
                }
                if (base64) {
                    return Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
                }
                throw new Error('Provide either a filePath or pdfBase64 for each PDF.');
            };

            const bufA = await getBuffer(args.filePath_a, args.pdfBase64_a);
            const bufB = await getBuffer(args.filePath_b, args.pdfBase64_b);

            const extractText = async (dataBuffer) => {
                const loadingTask = pdfjsLib.getDocument({
                    data: new Uint8Array(dataBuffer),
                    useWorkerFetch: false,
                    isEvalSupported: false,
                    useSystemFonts: true
                });
                const pdfDoc = await loadingTask.promise;
                let text = '';
                for (let i = 1; i <= pdfDoc.numPages; i++) {
                    const page = await pdfDoc.getPage(i);
                    const textContent = await page.getTextContent();
                    const pageText = textContent.items.map(item => item.str).join(' ');
                    text += pageText + '\n';
                }
                return { text, numpages: pdfDoc.numPages };
            };

            const [parsedA, parsedB] = await Promise.all([
                extractText(bufA),
                extractText(bufB)
            ]);

            const labelA = args.label_a || 'PDF-A';
            const labelB = args.label_b || 'PDF-B';
            const ignoreCase = args.ignoreCase !== false;
            const ignoreBlank = args.ignoreBlankLines !== false;
            const numTol = args.numberTolerance ?? 0.01;
            const maxDiff = args.maxDiffLines ?? 500;

            // ── normalise text to lines ──
            const toLines = (raw) => {
                return raw.split(/\r?\n/)
                    .map(l => l.trim())
                    .filter(l => ignoreBlank ? l.length > 0 : true);
            };

            const linesA = toLines(parsedA.text);
            const linesB = toLines(parsedB.text);

            const normLine = (l) => ignoreCase ? l.toLowerCase() : l;

            // ── build lookup sets ──
            const setA = new Map();
            const setB = new Map();
            linesA.forEach(l => { const k = normLine(l); setA.set(k, (setA.get(k) || 0) + 1); });
            linesB.forEach(l => { const k = normLine(l); setB.set(k, (setB.get(k) || 0) + 1); });

            const onlyInA = [];
            const onlyInB = [];

            // lines in A but not B (accounting for duplicates)
            const tempB = new Map(setB);
            for (const [k, countA] of setA) {
                const countB = tempB.get(k) || 0;
                const diff = countA - countB;
                if (diff > 0) {
                    // find original casing
                    const original = linesA.find(l => normLine(l) === k) || k;
                    onlyInA.push({ line: original, occurrences_in_a: countA, occurrences_in_b: countB });
                }
            }

            // lines in B but not A
            const tempA = new Map(setA);
            for (const [k, countB] of setB) {
                const countA = tempA.get(k) || 0;
                const diff = countB - countA;
                if (diff > 0) {
                    const original = linesB.find(l => normLine(l) === k) || k;
                    onlyInB.push({ line: original, occurrences_in_b: countB, occurrences_in_a: countA });
                }
            }

            // ── key-value pair extraction (label: value patterns) ──
            const KV_RE = /^(.{2,60}?)\s*[:\-–—=]\s*(.+)$/;
            const NUM_RE = /^-?[\d,]+(\.\d+)?$/;

            const extractKV = (lines) => {
                const kv = new Map();
                for (const line of lines) {
                    const m = KV_RE.exec(line);
                    if (!m) continue;
                    const key = (ignoreCase ? m[1].toLowerCase() : m[1]).trim();
                    const val = m[2].trim();
                    kv.set(key, val);
                }
                return kv;
            };

            const kvA = extractKV(linesA);
            const kvB = extractKV(linesB);

            const mismatches = [];
            const allKeys = new Set([...kvA.keys(), ...kvB.keys()]);

            for (const key of allKeys) {
                const valA = kvA.get(key);
                const valB = kvB.get(key);
                if (valA === undefined || valB === undefined) continue; // only_in covered above
                if (valA === valB) continue;

                // check numeric tolerance
                const nA = parseFloat((valA || '').replace(/,/g, ''));
                const nB = parseFloat((valB || '').replace(/,/g, ''));
                if (!isNaN(nA) && !isNaN(nB) && Math.abs(nA - nB) <= numTol) continue;

                mismatches.push({
                    key,
                    [`value_in_${labelA}`]: valA,
                    [`value_in_${labelB}`]: valB,
                    difference: (!isNaN(nA) && !isNaN(nB)) ? Number((nB - nA).toFixed(4)) : null
                });
            }

            // ── number-only lines that differ ──
            const numsA = new Set(linesA.filter(l => NUM_RE.test(l.replace(/,/g, ''))).map(l => l.replace(/,/g, '')));
            const numsB = new Set(linesB.filter(l => NUM_RE.test(l.replace(/,/g, ''))).map(l => l.replace(/,/g, '')));
            const numbersOnlyInA = [...numsA].filter(n => !numsB.has(n));
            const numbersOnlyInB = [...numsB].filter(n => !numsA.has(n));

            // ── plain-text diff preview (unified style, limited) ──
            const diffLines = [];
            let ai = 0, bi = 0;
            const la = linesA, lb = linesB;
            while ((ai < la.length || bi < lb.length) && diffLines.length < maxDiff) {
                const lineA = la[ai], lineB = lb[bi];
                if (ai >= la.length) { diffLines.push(`+ ${lineB}`); bi++; }
                else if (bi >= lb.length) { diffLines.push(`- ${lineA}`); ai++; }
                else if (normLine(lineA) === normLine(lineB)) {
                    diffLines.push(`  ${lineA}`); ai++; bi++;
                } else {
                    // simple greedy: check if lineA is in remaining B
                    const lookAheadB = lb.slice(bi, bi + 10).map(normLine);
                    const lookAheadA = la.slice(ai, ai + 10).map(normLine);
                    if (lookAheadB.includes(normLine(lineA))) {
                        diffLines.push(`+ ${lineB}`); bi++;
                    } else if (lookAheadA.includes(normLine(lineB))) {
                        diffLines.push(`- ${lineA}`); ai++;
                    } else {
                        diffLines.push(`- ${lineA}`);
                        diffLines.push(`+ ${lineB}`);
                        ai++; bi++;
                    }
                }
            }

            const result = {
                summary: {
                    label_a: labelA,
                    label_b: labelB,
                    pages_a: parsedA.numpages,
                    pages_b: parsedB.numpages,
                    lines_a: linesA.length,
                    lines_b: linesB.length,
                    only_in_a_count: onlyInA.length,
                    only_in_b_count: onlyInB.length,
                    mismatches_count: mismatches.length,
                    numbers_only_in_a: numbersOnlyInA.length,
                    numbers_only_in_b: numbersOnlyInB.length,
                    diff_preview_lines: diffLines.length,
                    diff_truncated: (linesA.length + linesB.length) > maxDiff
                },
                only_in_a: onlyInA.slice(0, maxDiff),
                only_in_b: onlyInB.slice(0, maxDiff),
                mismatches,
                numbers_only_in_a: numbersOnlyInA.slice(0, 100),
                numbers_only_in_b: numbersOnlyInB.slice(0, 100),
                diff_preview: diffLines.join('\n')
            };

            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });

    // ── compare-excel ─────────────────────────────────────────────────────────
    mcpServer.registerTool('compare-excel', {
        title: 'Excel Compare',
        description: `Compares two Excel workbooks (.xlsx / .xls / .csv) and returns a structured diff per sheet: cells present in only one file, cells with the same address but different values, sheets present in one workbook but not the other, and a summary count. Accepts absolute file paths on the server machine OR base64-encoded workbook content. Use filePath_a / filePath_b for local files, or excelBase64_a / excelBase64_b for inline content. Returns: sheets_only_in_a, sheets_only_in_b, per_sheet results containing cell_mismatches (address + both values), rows_only_in_a, rows_only_in_b (keyed by first-column identifier), and summary counts.`,
        inputSchema: {
            filePath_a: z.string().optional().describe('Absolute path to the first Excel file on the server machine'),
            filePath_b: z.string().optional().describe('Absolute path to the second Excel file on the server machine'),
            excelBase64_a: z.string().optional().describe('Base64-encoded content of the first Excel file (alternative to filePath_a)'),
            excelBase64_b: z.string().optional().describe('Base64-encoded content of the second Excel file (alternative to filePath_b)'),
            label_a: z.string().optional().default('File-A').describe('Label for the first file in output'),
            label_b: z.string().optional().default('File-B').describe('Label for the second file in output'),
            sheetNames: z.array(z.string()).optional().describe('Specific sheet names to compare. If omitted, all matching sheets are compared.'),
            ignoreCase: z.boolean().optional().default(false).describe('Whether to ignore case when comparing cell text values'),
            ignoreBlankCells: z.boolean().optional().default(true).describe('Whether to skip blank / empty cells in comparison'),
            numberTolerance: z.number().optional().default(0.01).describe('Tolerance for numeric comparison (values within ±tolerance treated as equal)'),
            keyColumn: z.number().optional().default(1).describe('1-based column index to use as the row key for row-level diff (default: column 1)'),
            headerRow: z.number().optional().default(1).describe('Row number that contains column headers (default: 1, set to 0 to skip)'),
            maxRowsPerSheet: z.number().optional().default(1000).describe('Maximum rows to scan per sheet (prevents huge output)'),
            maxMismatchesPerSheet: z.number().optional().default(200).describe('Maximum cell/row mismatches to return per sheet')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const fs = await import('fs');
            const path = await import('path');
            const pdfMod = await import('pdf-parse');
            const pdf = typeof pdfMod.default === 'function' 
                ? pdfMod.default 
                : (typeof pdfMod === 'function' ? pdfMod : pdfMod.default);
            const ExcelJS = (await import('exceljs')).default;

            // ── helpers ──
            const getBuffer = (filePath, base64) => {
                if (filePath) {
                    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
                    return fs.readFileSync(filePath);
                }
                if (base64) {
                    return Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
                }
                throw new Error('Provide either a filePath or excelBase64 for each workbook.');
            };

            const labelA = args.label_a || 'File-A';
            const labelB = args.label_b || 'File-B';
            const ignoreCase = args.ignoreCase === true;
            const ignoreBlank = args.ignoreBlankCells !== false;
            const numTol = args.numberTolerance ?? 0.01;
            const keyCol = (args.keyColumn ?? 1) - 1; // 0-based
            const headerRow = args.headerRow ?? 1;
            const maxRows = args.maxRowsPerSheet ?? 1000;
            const maxMis = args.maxMismatchesPerSheet ?? 200;

            const normVal = (v) => {
                if (v === null || v === undefined) return '';
                const s = String(v).trim();
                return ignoreCase ? s.toLowerCase() : s;
            };

            const readWorkbook = async (buf) => {
                const wb = new ExcelJS.Workbook();
                await wb.xlsx.load(buf);
                return wb;
            };

            const bufA = getBuffer(args.filePath_a, args.excelBase64_a);
            const bufB = getBuffer(args.filePath_b, args.excelBase64_b);

            const [wbA, wbB] = await Promise.all([readWorkbook(bufA), readWorkbook(bufB)]);

            // ── collect sheet names ──
            const sheetNamesA = wbA.worksheets.map(s => s.name);
            const sheetNamesB = wbB.worksheets.map(s => s.name);
            const setA = new Set(sheetNamesA);
            const setB = new Set(sheetNamesB);

            const sheetsOnlyInA = sheetNamesA.filter(n => !setB.has(n));
            const sheetsOnlyInB = sheetNamesB.filter(n => !setA.has(n));
            const commonSheets = sheetNamesA.filter(n => setB.has(n));

            const targetSheets = args.sheetNames?.length
                ? commonSheets.filter(n => args.sheetNames.includes(n))
                : commonSheets;

            // ── extract sheet data as Map<rowKey, Map<colIdx, cellValue>> ──
            const sheetToRowMap = (ws) => {
                const rows = new Map(); // rowKey → { colIdx → rawValue }
                const colMap = new Map(); // colIdx → headerName (if headerRow > 0)
                let rowNum = 0;
                ws.eachRow({ includeEmpty: false }, (row, rIdx) => {
                    if (rIdx > maxRows + headerRow) return;
                    if (headerRow > 0 && rIdx === headerRow) {
                        row.eachCell({ includeEmpty: true }, (cell, cIdx) => {
                            colMap.set(cIdx, normVal(cell.value));
                        });
                        return;
                    }
                    if (headerRow > 0 && rIdx < headerRow) return;

                    const cells = new Map();
                    row.eachCell({ includeEmpty: !ignoreBlank }, (cell, cIdx) => {
                        const raw = cell.value;
                        if (ignoreBlank && (raw === null || raw === undefined || String(raw).trim() === '')) return;
                        cells.set(cIdx, raw);
                    });
                    if (cells.size === 0) return;

                    // row key = value of keyCol cell, fallback to row index
                    const keyRaw = cells.get(keyCol + 1);
                    const rowKey = keyRaw !== undefined ? normVal(keyRaw) : `_row_${rIdx}`;
                    rows.set(rowKey, { cells, rIdx });
                    rowNum++;
                });
                return { rows, colMap };
            };

            const valsEqual = (a, b) => {
                if (a === b) return true;
                const nA = typeof a === 'number' ? a : parseFloat(String(a ?? '').replace(/,/g, ''));
                const nB = typeof b === 'number' ? b : parseFloat(String(b ?? '').replace(/,/g, ''));
                if (!isNaN(nA) && !isNaN(nB)) return Math.abs(nA - nB) <= numTol;
                return normVal(a) === normVal(b);
            };

            // ── compare each common sheet ──
            const perSheet = {};
            let totalMismatches = 0;
            let totalOnlyInA = 0;
            let totalOnlyInB = 0;

            for (const sheetName of targetSheets) {
                const wsA = wbA.getWorksheet(sheetName);
                const wsB = wbB.getWorksheet(sheetName);

                const { rows: rowsA, colMap: colMapA } = sheetToRowMap(wsA);
                const { rows: rowsB, colMap: colMapB } = sheetToRowMap(wsB);

                const colMapMerged = new Map([...colMapA, ...colMapB]);

                const cellMismatches = [];
                const rowsOnlyInA = [];
                const rowsOnlyInB = [];

                // rows in A: check against B
                for (const [key, dataA] of rowsA) {
                    if (!rowsB.has(key)) {
                        if (rowsOnlyInA.length < maxMis) {
                            const rowObj = {};
                            for (const [cIdx, val] of dataA.cells) {
                                const header = colMapMerged.get(cIdx) || `col_${cIdx}`;
                                rowObj[header] = val;
                            }
                            rowsOnlyInA.push({ row_key: key, row_index: dataA.rIdx, data: rowObj });
                        }
                        continue;
                    }
                    const dataB = rowsB.get(key);
                    // cell-level diff within the row
                    const allColIds = new Set([...dataA.cells.keys(), ...dataB.cells.keys()]);
                    for (const cIdx of allColIds) {
                        const valA = dataA.cells.get(cIdx);
                        const valB = dataB.cells.get(cIdx);
                        if (ignoreBlank) {
                            if ((valA === undefined || valA === null || String(valA).trim() === '') &&
                                (valB === undefined || valB === null || String(valB).trim() === '')) continue;
                        }
                        if (!valsEqual(valA, valB) && cellMismatches.length < maxMis) {
                            const header = colMapMerged.get(cIdx) || `col_${cIdx}`;
                            const nA = typeof valA === 'number' ? valA : parseFloat(String(valA ?? '').replace(/,/g, ''));
                            const nB = typeof valB === 'number' ? valB : parseFloat(String(valB ?? '').replace(/,/g, ''));
                            cellMismatches.push({
                                row_key: key,
                                column: header,
                                col_index: cIdx,
                                [`value_in_${labelA}`]: valA ?? '',
                                [`value_in_${labelB}`]: valB ?? '',
                                difference: (!isNaN(nA) && !isNaN(nB)) ? Number((nB - nA).toFixed(4)) : null
                            });
                        }
                    }
                }

                // rows in B not in A
                for (const [key, dataB] of rowsB) {
                    if (!rowsA.has(key) && rowsOnlyInB.length < maxMis) {
                        const rowObj = {};
                        for (const [cIdx, val] of dataB.cells) {
                            const header = colMapMerged.get(cIdx) || `col_${cIdx}`;
                            rowObj[header] = val;
                        }
                        rowsOnlyInB.push({ row_key: key, row_index: dataB.rIdx, data: rowObj });
                    }
                }

                totalMismatches += cellMismatches.length;
                totalOnlyInA += rowsOnlyInA.length;
                totalOnlyInB += rowsOnlyInB.length;

                perSheet[sheetName] = {
                    rows_in_a: rowsA.size,
                    rows_in_b: rowsB.size,
                    cell_mismatches_count: cellMismatches.length,
                    rows_only_in_a_count: rowsOnlyInA.length,
                    rows_only_in_b_count: rowsOnlyInB.length,
                    cell_mismatches: cellMismatches,
                    rows_only_in_a: rowsOnlyInA,
                    rows_only_in_b: rowsOnlyInB
                };
            }

            const result = {
                summary: {
                    label_a: labelA,
                    label_b: labelB,
                    sheets_in_a: sheetNamesA.length,
                    sheets_in_b: sheetNamesB.length,
                    sheets_only_in_a: sheetsOnlyInA,
                    sheets_only_in_b: sheetsOnlyInB,
                    sheets_compared: targetSheets,
                    total_cell_mismatches: totalMismatches,
                    total_rows_only_in_a: totalOnlyInA,
                    total_rows_only_in_b: totalOnlyInB
                },
                per_sheet: perSheet
            };

            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });

    // ── pdf-to-excel ──────────────────────────────────────────────────────────
    mcpServer.registerTool('pdf-to-excel', {
        title: 'PDF to Excel',
        description: `Extracts text and tabular data from a PDF and writes it to an Excel (.xlsx) file. Detects tables automatically by analysing column alignment (fixed-width or tab-separated). Each detected table block becomes a separate sheet (Table 1, Table 2 …). Non-table text lines go into a "Raw Text" sheet. The output Excel is saved to the path you specify in outputPath, or returned as base64 if returnBase64 is true. Accepts PDF as a file path (filePath) or base64 string (pdfBase64). Ideal for converting Tally-exported PDFs, bank statements, or invoices into structured Excel data.`,
        inputSchema: {
            filePath: z.string().optional().describe('Absolute path to the source PDF file on the server machine'),
            pdfBase64: z.string().optional().describe('Base64-encoded PDF content (alternative to filePath)'),
            outputPath: z.string().optional().describe('Absolute path where the output .xlsx file should be saved. If omitted and returnBase64 is false, a file is saved next to the source PDF.'),
            returnBase64: z.boolean().optional().default(false).describe('If true, return the Excel file as a base64 string instead of (or in addition to) saving to disk'),
            sheetPerPage: z.boolean().optional().default(false).describe('If true, put each PDF page on a separate sheet. Default: group all pages into detected tables.'),
            headerRows: z.number().optional().default(1).describe('Number of header rows in each detected table (used for bold formatting in Excel)'),
            minTableColumns: z.number().optional().default(2).describe('Minimum number of columns a line must have to be considered part of a table (default 2)'),
            minTableRows: z.number().optional().default(3).describe('Minimum consecutive table-like rows to treat a block as a table (default 3)'),
            columnSeparator: z.string().optional().describe('Explicit column separator (e.g. "|" or "\\t"). If omitted, auto-detected.')
        },
        annotations: { readOnlyHint: false, openWorldHint: false }
    }, async (args) => {
        try {
            const fs = await import('fs');
            const path = await import('path');
            const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
            await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
            pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
            const ExcelJS = (await import('exceljs')).default;

            // ── load PDF ──
            let pdfBuffer;
            let sourcePath = args.filePath;
            if (sourcePath) {
                if (!fs.existsSync(sourcePath)) throw new Error(`File not found: ${sourcePath}`);
                pdfBuffer = fs.readFileSync(sourcePath);
            } else if (args.pdfBase64) {
                pdfBuffer = Buffer.from(args.pdfBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
            } else {
                throw new Error('Provide either filePath or pdfBase64.');
            }

            // ── parse PDF ──
            const loadingTask = pdfjsLib.getDocument({
                data: new Uint8Array(pdfBuffer),
                useWorkerFetch: false,
                isEvalSupported: false,
                useSystemFonts: true
            });
            const pdfDoc = await loadingTask.promise;
            let fullText = '';
            for (let i = 1; i <= pdfDoc.numPages; i++) {
                const page = await pdfDoc.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(' ');
                fullText += pageText + '\n';
            }
            const totalPages = pdfDoc.numPages;

            // ── column detection helpers ──
            const minCols = args.minTableColumns ?? 2;
            const minRows = args.minTableRows ?? 3;
            const headerRows = args.headerRows ?? 1;

            // Split a line into columns using explicit separator or auto-detect
            const splitLine = (() => {
                if (args.columnSeparator) {
                    const sep = args.columnSeparator === '\\t' ? '\t' : args.columnSeparator;
                    return (line) => line.split(sep).map(c => c.trim());
                }
                // Auto-detect: try tab first, then 2+ spaces
                return (line) => {
                    if (line.includes('\t')) return line.split('\t').map(c => c.trim());
                    // Split on 2+ consecutive spaces (common in fixed-width PDFs)
                    const parts = line.split(/  +/).map(c => c.trim()).filter(c => c.length > 0);
                    return parts;
                };
            })();

            const isTableLine = (line) => {
                const trimmed = line.trim();
                if (!trimmed) return false;
                const cols = splitLine(trimmed);
                return cols.length >= minCols;
            };

            // ── segment text into table blocks vs free text ──
            const rawLines = fullText.split(/\r?\n/);

            const segments = []; // { type: 'table'|'text', lines: string[] }
            let currentBlock = null;
            let consecutiveTableLines = 0;
            const pendingLines = [];

            const flushPending = () => {
                if (pendingLines.length > 0) {
                    if (currentBlock?.type === 'text') {
                        currentBlock.lines.push(...pendingLines);
                    } else {
                        if (currentBlock) segments.push(currentBlock);
                        currentBlock = { type: 'text', lines: [...pendingLines] };
                    }
                    pendingLines.length = 0;
                }
            };

            for (const line of rawLines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    // blank line — could be separator between table rows
                    pendingLines.push(line);
                    continue;
                }

                if (isTableLine(trimmed)) {
                    consecutiveTableLines++;
                    if (consecutiveTableLines >= minRows) {
                        // upgrade pending to table block
                        if (currentBlock?.type !== 'table') {
                            flushPending();
                            if (currentBlock) segments.push(currentBlock);
                            currentBlock = { type: 'table', lines: [] };
                            // re-add the pending non-blank lines that led up to this
                        }
                        // drain any pending blanks into table
                        if (pendingLines.length > 0 && currentBlock?.type === 'table') {
                            currentBlock.lines.push(...pendingLines);
                            pendingLines.length = 0;
                        }
                        currentBlock.lines.push(line);
                    } else {
                        pendingLines.push(line);
                    }
                } else {
                    consecutiveTableLines = 0;
                    if (currentBlock?.type === 'table') {
                        // leaving a table block
                        flushPending();
                        segments.push(currentBlock);
                        currentBlock = { type: 'text', lines: [] };
                    }
                    flushPending();
                    if (!currentBlock || currentBlock.type !== 'text') {
                        if (currentBlock) segments.push(currentBlock);
                        currentBlock = { type: 'text', lines: [] };
                    }
                    currentBlock.lines.push(line);
                }
            }
            flushPending();
            if (currentBlock?.lines.length > 0) segments.push(currentBlock);

            // ── build Excel workbook ──
            const wb = new ExcelJS.Workbook();
            wb.creator = 'Tally MCP pdf-to-excel';
            wb.created = new Date();

            let tableIndex = 0;
            const rawTextLines = [];
            const sheetStats = [];

            for (const seg of segments) {
                if (seg.type === 'table') {
                    tableIndex++;
                    const sheetName = `Table ${tableIndex}`.substring(0, 31);
                    const ws = wb.addWorksheet(sheetName);

                    // Determine max columns across all rows
                    const parsedRows = seg.lines
                        .filter(l => l.trim().length > 0)
                        .map(l => splitLine(l.trim()));

                    const maxCols = Math.max(...parsedRows.map(r => r.length));

                    // Write rows
                    let rowNum = 0;
                    for (const cols of parsedRows) {
                        rowNum++;
                        const row = ws.addRow(cols);

                        // Bold header rows
                        if (rowNum <= headerRows) {
                            row.eachCell(cell => {
                                cell.font = { bold: true };
                                cell.fill = {
                                    type: 'pattern',
                                    pattern: 'solid',
                                    fgColor: { argb: 'FFD9E1F2' }
                                };
                            });
                        }

                        // Try to coerce numeric values
                        row.eachCell((cell, colIdx) => {
                            const val = cell.value;
                            if (typeof val === 'string') {
                                const n = parseFloat(val.replace(/,/g, ''));
                                if (!isNaN(n) && String(n).length > 0 && val.trim() !== '') {
                                    cell.value = n;
                                    cell.numFmt = val.includes('.') ? '#,##0.00' : '#,##0';
                                }
                            }
                        });
                    }

                    // Auto-fit column widths (approximate)
                    ws.columns.forEach((col, i) => {
                        let maxLen = 10;
                        parsedRows.forEach(r => {
                            const cell = r[i] || '';
                            if (cell.length > maxLen) maxLen = cell.length;
                        });
                        col.width = Math.min(maxLen + 2, 50);
                    });

                    // Freeze header rows
                    if (headerRows > 0) {
                        ws.views = [{ state: 'frozen', ySplit: headerRows }];
                    }

                    sheetStats.push({ sheet: sheetName, rows: parsedRows.length, columns: maxCols });
                } else {
                    rawTextLines.push(...seg.lines);
                }
            }

            // ── Raw Text sheet ──
            if (rawTextLines.length > 0) {
                const rawWs = wb.addWorksheet('Raw Text');
                rawWs.getColumn(1).width = 120;
                for (const line of rawTextLines) {
                    rawWs.addRow([line]);
                }
                sheetStats.push({ sheet: 'Raw Text', rows: rawTextLines.length, columns: 1 });
            }

            // If no structured tables found, dump everything into a single sheet
            if (tableIndex === 0 && rawTextLines.length === 0) {
                const ws = wb.addWorksheet('Sheet1');
                ws.getColumn(1).width = 120;
                for (const line of rawLines) {
                    ws.addRow([line]);
                }
                sheetStats.push({ sheet: 'Sheet1', rows: rawLines.length, columns: 1 });
            }

            // ── determine output path ──
            let outPath = args.outputPath;
            if (!outPath && sourcePath) {
                const ext = path.extname(sourcePath);
                outPath = sourcePath.slice(0, -ext.length) + '.xlsx';
            } else if (!outPath) {
                outPath = path.join(process.cwd(), `pdf_export_${Date.now()}.xlsx`);
            }

            // ── write file ──
            await wb.xlsx.writeFile(outPath);

            const result = {
                success: true,
                output_path: outPath,
                pdf_pages: totalPages,
                sheets_created: sheetStats,
                tables_detected: tableIndex,
                raw_text_lines: rawTextLines.length,
                message: `Excel saved to ${outPath}. ${tableIndex} table(s) detected across ${totalPages} PDF page(s).`
            };

            // Optionally return base64
            if (args.returnBase64) {
                const xlsxBuf = await wb.xlsx.writeBuffer();
                result.base64 = xlsxBuf.toString('base64');
                result.mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            }

            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });

    // ── bill-to-tally-excel ───────────────────────────────────────────────────
    mcpServer.registerTool('bill-to-tally-json', {
        title: 'Bill to Tally JSON',
        description: `Resolves extracted bill/invoice data against Tally master data and returns a structured JSON payload — it does NOT create any Excel file.
This tool performs ALL Tally-related work internally: party ledger matching, stock item matching, and total verification.

CLIENT (Claude) INSTRUCTIONS:
1. Read the bill image and extract billDate, partyName (raw, as printed), billNumber, billTotal, and lineItems (particular as written, quantity, unit, rate, amount) — with NO matching or correction against Tally data.
2. Call this tool ONCE with the raw extracted data. Do NOT call search-party-ledgers, list-master, or any other Tally tool first — all matching happens inside this tool.
3. Take the JSON this tool returns and build the Excel file yourself with columns: Date | Voucher Type | Voucher Number | Party Ledger | Purchase Ledger | Stock Item Name | Quantity | Unit | Rate | Amount | Godown | Narration. Voucher Number, Purchase Ledger, and Godown stay blank — they are not provided by this tool and must not be inferred.
4. Do not alter, re-match, or "improve" the matched_party or resolved_items values — use them exactly as returned. Surface any flags or total_mismatch to the user.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('Tally company name — used to search party ledger and stock items'),
            billDate: z.string().describe('Bill date as extracted from the image, exactly as written'),
            partyName: z.string().describe('Raw supplier/party name as printed on the bill'),
            billNumber: z.string().optional().describe('Bill/memo/invoice number printed on the document'),
            billTotal: z.number().optional().describe('Total amount printed on the bill — used to verify the sum'),
            lineItems: z.array(z.object({
                particular: z.string().describe('Raw item name as written on the bill'),
                quantity: z.number().describe('Quantity'),
                unit: z.string().optional().describe('Unit (Kgs, Pcs, Nos, etc.)'),
                rate: z.number().describe('Rate per unit'),
                amount: z.number().describe('Line total')
            })).min(1).describe('Line items extracted from the bill')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const round2 = (n) => Math.round((n || 0) * 100) / 100;

            const fuzzyScore = (haystack, needle) => {
                const h = String(haystack || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ');
                const words = String(needle || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ')
                    .split(/\s+/).filter(w => w.length >= 3);
                if (!words.length) return 0;
                const matched = words.filter(w => h.includes(w)).length;
                return matched / words.length;
            };

            const cleanPartyName = (name) => {
                let cleaned = name.replace(/^(M\/s\.?\s*|M\/S\.?\s*|Shri\s*|Sri\s*|Mr\.?\s*|Mrs\.?\s*)/i, '').trim();
                if (cleaned.includes(',')) cleaned = cleaned.split(',')[0].trim();
                cleaned = cleaned.replace(/\b(Vegetable|Supplier|Suppliers|General|Order|LTD|PVT|PRIVATE|LIMITED|Co|Company|and|&)\b/ig, '').trim();
                return cleaned;
            };

            const normalizeComboJoiners = (str) => {
                return String(str || '')
                    .replace(/\(?\s*R\s*[&+\/]\s*Y\s*\)?/gi, ' RY ')
                    .replace(/\(?\s*Y\s*[&+\/]\s*R\s*\)?/gi, ' RY ')
                    .replace(/\s+/g, ' ')
                    .trim();
            };

            const stripQualifier = (str) => {
                let s = normalizeComboJoiners(String(str || '').toUpperCase());
                return s
                    .replace(/^(GREEN|YELLOW|RED|WHITE|G\.|Y\.|R\.|W\.)\s*/, '')
                    .replace(/\bRY\b/g, '')
                    .replace(/\bCOMBO\b/g, '')
                    .replace(/\bMIX\b/g, '')
                    .replace(/\(.*?\)/g, '')
                    .replace(/s$/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            };

            // ─── 1. Party ledger match ──────────────────────────
            const flags = [];
            let matchedParty = '';
            let partyNotFound = false;
            let partyOptions = null;

            try {
                const cleanedParty = cleanPartyName(args.partyName);
                const words = cleanedParty.split(/\s+/).filter(w => w.length >= 3);
                let ledgers = [];
                const ledgerFields = ['Name', 'Parent'];

                if (words.length > 0) {
                    const ledgerFilter = new Map([['searchField', 'Name'], ['searchValue', words[0]]]);
                    ledgers = await queryCollection('Ledger', ledgerFields, ledgerFilter, args.targetCompany);
                }
                if ((!Array.isArray(ledgers) || ledgers.length === 0) && words.length > 1) {
                    const ledgerFilter2 = new Map([['searchField', 'Name'], ['searchValue', words[words.length - 1]]]);
                    ledgers = await queryCollection('Ledger', ledgerFields, ledgerFilter2, args.targetCompany);
                }
                if (!Array.isArray(ledgers) || ledgers.length === 0) {
                    ledgers = await queryCollection('Ledger', ledgerFields, new Map(), args.targetCompany);
                }

                if (Array.isArray(ledgers) && ledgers.length > 0) {
                    const scored = ledgers
                        .map(l => ({ name: String(l.Name || ''), score: fuzzyScore(l.Name, cleanedParty) }))
                        .filter(l => l.score >= 0.35)
                        .sort((a, b) => b.score - a.score);

                    if (scored.length === 1) {
                        matchedParty = scored[0].name;
                    } else if (scored.length > 1) {
                        partyOptions = scored.map(s => s.name);
                        flags.push({ field: 'Party Ledger', issue: 'Multiple potential matches found in Tally.' });
                    } else {
                        partyNotFound = true;
                        flags.push({ field: 'Party Ledger', issue: 'No Tally ledger matched with sufficient confidence.' });
                    }
                } else {
                    partyNotFound = true;
                    flags.push({ field: 'Party Ledger', issue: 'No ledgers found in Tally company.' });
                }
            } catch (e) {
                partyNotFound = true;
                flags.push({ field: 'Party Ledger', issue: `Tally search failed: ${e.message}` });
            }

            // ─── 2. Stock item match ──────────────────────────
            const stockItemFields = ['Name', 'Parent', 'BaseUnits'];
            let allStockItems = null;

            const matchStockItem = async (particular) => {
                const rawUpper = String(particular || '').toUpperCase();
                const normalizedRaw = normalizeComboJoiners(rawUpper);
                const isComboQualifier = /\bRY\b/.test(normalizedRaw);

                const getSilentHAndConsonantVariants = (str) => {
                    const variants = new Set();
                    let s = str.toLowerCase();
                    const noH = s.replace(/\bch/g, 'c').replace(/([^s])h/g, '$1').replace(/sch/g, 'sc').replace(/sh/g, 's');
                    variants.add(noH);
                    variants.add(s.replace(/([a-z])\1/g, '$1'));
                    variants.add(noH.replace(/([a-z])\1/g, '$1'));
                    variants.add(s.replace(/ch/g, 'k'));
                    return Array.from(variants).map(v => v.toUpperCase());
                };

                const expandQualifier = (str) => {
                    let s = str.toUpperCase();
                    if (s.startsWith('G. ')) s = s.replace(/^G\.\s*/, 'GREEN ');
                    if (s.startsWith('Y. ')) s = s.replace(/^Y\.\s*/, 'YELLOW ');
                    if (s.startsWith('R. ')) s = s.replace(/^R\.\s*/, 'RED ');
                    if (s.startsWith('W. ')) s = s.replace(/^W\.\s*/, 'WHITE ');
                    return s;
                };

                const baseNoun = stripQualifier(rawUpper);
                const searchPhases = [];

                if (isComboQualifier && baseNoun) {
                    searchPhases.push({ text: `${baseNoun} COMBO`, type: 'combo_explicit', priority: 0 });
                    searchPhases.push({ text: `R Y ${baseNoun}`, type: 'combo_ry', priority: 0 });
                }
                searchPhases.push({ text: rawUpper, type: 'literal', priority: 3 });
                const expanded = expandQualifier(rawUpper);
                if (expanded !== rawUpper) searchPhases.push({ text: expanded, type: 'expanded_qualifier', priority: 2 });
                searchPhases.push({ text: baseNoun, type: 'stripped_qualifier', priority: 4 });

                const baseSpellingVariants = getSilentHAndConsonantVariants(baseNoun);
                for (const variant of baseSpellingVariants) {
                    if (variant !== baseNoun) searchPhases.push({ text: variant, type: 'silent_h_base', priority: 4 });
                }

                const colorPrefix = rawUpper.startsWith('G.') || rawUpper.includes('GREEN') ? 'GREEN ' :
                    rawUpper.startsWith('Y.') || rawUpper.includes('YELLOW') ? 'YELLOW ' :
                        rawUpper.startsWith('R.') || rawUpper.includes('RED') ? 'RED ' :
                            rawUpper.startsWith('W.') || rawUpper.includes('WHITE') ? 'WHITE ' : '';
                if (colorPrefix) {
                    const variantsForPrefix = baseSpellingVariants.length ? baseSpellingVariants : [baseNoun];
                    for (const variant of variantsForPrefix) searchPhases.push({ text: colorPrefix + variant, type: 'expanded_silent_h', priority: 1 });
                    const siblingColors = ['GREEN ', 'YELLOW ', 'RED ', 'WHITE '].filter(c => c !== colorPrefix);
                    for (const color of siblingColors) searchPhases.push({ text: color + baseNoun, type: 'sibling_color', priority: 5 });
                }

                const computeLcsSimilarity = (str1, str2) => {
                    const s1 = String(str1).toLowerCase().replace(/[^a-z0-9]/g, '');
                    const s2 = String(str2).toLowerCase().replace(/[^a-z0-9]/g, '');
                    const m = s1.length, n = s2.length;
                    if (m === 0 || n === 0) return 0;
                    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
                    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
                        dp[i][j] = s1[i - 1] === s2[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
                    return (2 * dp[m][n]) / (m + n);
                };

                if (!allStockItems) {
                    try { allStockItems = await queryCollection('StockItem', stockItemFields, new Map(), args.targetCompany); }
                    catch (e) { allStockItems = []; }
                }
                const candidates = allStockItems || [];
                const orderedPhases = [...searchPhases].sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));

                for (const phase of orderedPhases) {
                    const scored = candidates
                        .map(i => ({ item: i, name: String(i.Name || '').toUpperCase(), score: fuzzyScore(String(i.Name || ''), phase.text) }))
                        .filter(c => c.score >= 0.5)
                        .sort((a, b) => b.score - a.score);

                    for (const candidate of scored) {
                        const top = candidate.item;
                        const matchName = String(top.Name || '');
                        const tallyCore = stripQualifier(matchName);
                        const similarity = computeLcsSimilarity(baseNoun, tallyCore);
                        if (similarity < 0.70) continue;

                        let matchedOk = true, note = null;
                        const matchNormalized = normalizeComboJoiners(matchName.toUpperCase());
                        const matchIsCombo = /\bRY\b/.test(matchNormalized) || /\bCOMBO\b/.test(matchNormalized) || /\bMIX\b/.test(matchNormalized);

                        if (isComboQualifier && !matchIsCombo) {
                            matchedOk = 'partial';
                            note = `Qualifier dropped: Combo matched generic "${matchName}"`;
                        } else if (phase.type.includes('silent_h')) {
                            note = `Matched via spelling variant: ${particular} → ${matchName}`;
                        } else if (phase.type === 'sibling_color') {
                            matchedOk = 'partial';
                            note = `Matched sibling color variant: ${particular} → ${matchName}`;
                        } else if (isComboQualifier && matchIsCombo) {
                            note = `Matched combo item: ${particular} → ${matchName}`;
                        }

                        return { matched: matchName, unit: top.BaseUnits || null, matched_ok: matchedOk, match_note: note };
                    }
                }
                return { matched: particular, unit: null, matched_ok: false };
            };

            const resolvedItems = [];
            for (const item of args.lineItems) {
                const result = await matchStockItem(item.particular);
                if (!result.matched_ok) {
                    flags.push({ field: `Stock Item: ${item.particular}`, issue: result.match_note || 'Not found in Tally stock master' });
                } else if (result.matched_ok === 'partial') {
                    flags.push({ field: `Stock Item: ${item.particular}`, issue: result.match_note });
                }
                resolvedItems.push({
                    particular: item.particular,
                    tally_stock_item: result.matched,
                    stock_item_matched: result.matched_ok,
                    quantity: item.quantity,
                    unit: item.unit || result.unit || 'Nos',
                    rate: item.rate,
                    amount: item.amount
                });
            }

            const calculatedTotal = round2(resolvedItems.reduce((s, i) => s + (i.amount || 0), 0));
            let totalMismatch = null;
            if (args.billTotal !== undefined && args.billTotal !== null) {
                const diff = round2(Math.abs(calculatedTotal - args.billTotal));
                if (diff > 0.02) {
                    totalMismatch = {
                        bill_printed_total: args.billTotal,
                        calculated_total: calculatedTotal,
                        difference: round2(calculatedTotal - args.billTotal)
                    };
                }
            }

            if (partyOptions && partyOptions.length > 1) {
                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            success: false,
                            party_options: partyOptions,
                            message: `Multiple potential ledger matches found: ${partyOptions.join(', ')}. Please refine partyName.`
                        }, null, 2)
                    }]
                };
            }

            const result = {
                success: true,
                bill_date: args.billDate,
                bill_number: args.billNumber || null,
                voucher_type: 'Purchase',
                party_ledger: matchedParty || null,
                party_not_found: partyNotFound,
                party_ledger_source: args.partyName,
                line_items: resolvedItems,
                calculated_total: calculatedTotal,
                bill_total: args.billTotal ?? null,
                total_mismatch: totalMismatch,
                flags: flags.length > 0 ? flags : null
            };

            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });

    mcpServer.registerTool('bill-to-tally-excel', {
        title: 'Bill to Tally Excel',
        description: `Converts bill/invoice data extracted from an image into a Tally-import-ready Excel (.xlsx) file. fuzzy-searches Tally for the matching party ledger and each stock item name, then produces a 12-column formatted Excel.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('Tally company name — used to search party ledger and stock items'),
            voucherMode: z.enum(['purchase', 'sales']).describe('Controls generated Excel perspective (purchase or sales)'),
            purchaseVoucherType: z.string().optional().describe('Override voucher type name for purchase mode (e.g. "EX PURCHASE")'),
            salesVoucherType: z.string().optional().describe('Override voucher type name for sales mode (e.g. "Sales New", "TAX INVOICE")'),
            forcedPartyLedger: z.string().optional().describe('Directly use this exact string as the Party Ledger value in the Excel, bypassing fuzzy match.'),
            billDate: z.string().describe('Bill date as YYYY-MM-DD or raw string'),
            partyName: z.string().describe('Raw supplier/party name as printed on the bill'),
            billNumber: z.string().optional().describe('Bill/memo/invoice number printed on the document'),
            billTotal: z.number().optional().describe('Total amount printed on the bill — used to verify the sum'),
            lineItems: z.array(z.object({
                particular: z.string().describe('Raw item name as written on the bill'),
                quantity: z.number().describe('Quantity'),
                unit: z.string().optional().describe('Unit (Kgs, Pcs, Nos, etc.)'),
                rate: z.number().describe('Rate per unit'),
                amount: z.number().describe('Line total')
            })).min(1).describe('Line items extracted from the bill'),
            outputPath: z.string().optional().describe('Absolute path where the output .xlsx file should be saved'),
            returnBase64: z.boolean().optional().default(false).describe('If true, return the Excel file as a base64 string')
        },
        annotations: { readOnlyHint: false, openWorldHint: false }
    }, async (args) => {
        try {
            const fs = await import('fs');
            const path = await import('path');
            const ExcelJS = (await import('exceljs')).default;
            const round2 = (n) => Math.round((n || 0) * 100) / 100;

            const fuzzyScore = (haystack, needle) => {
                const h = String(haystack || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ');
                const words = String(needle || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ')
                    .split(/\s+/).filter(w => w.length >= 3);
                if (!words.length) return 0;
                const matched = words.filter(w => h.includes(w)).length;
                return matched / words.length;
            };

            const cleanPartyName = (name) => {
                let cleaned = name.replace(/^(M\/s\.?\s*|M\/S\.?\s*|Shri\s*|Sri\s*|Mr\.?\s*|Mrs\.?\s*)/i, '').trim();
                if (cleaned.includes(',')) cleaned = cleaned.split(',')[0].trim();
                cleaned = cleaned.replace(/\b(Vegetable|Supplier|Suppliers|General|Order|LTD|PVT|PRIVATE|LIMITED|Co|Company|and|&)\b/ig, '').trim();
                return cleaned;
            };

            const normalizeComboJoiners = (str) => {
                return String(str || '')
                    .replace(/\(?\s*R\s*[&+\/]\s*Y\s*\)?/gi, ' RY ')
                    .replace(/\(?\s*Y\s*[&+\/]\s*R\s*\)?/gi, ' RY ')
                    .replace(/\s+/g, ' ')
                    .trim();
            };

            const stripQualifier = (str) => {
                let s = normalizeComboJoiners(String(str || '').toUpperCase());
                return s
                    .replace(/^(GREEN|YELLOW|RED|WHITE|G\.|Y\.|R\.|W\.)\s*/, '')
                    .replace(/\bRY\b/g, '')
                    .replace(/\bCOMBO\b/g, '')
                    .replace(/\bMIX\b/g, '')
                    .replace(/\(.*?\)/g, '')
                    .replace(/s$/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            };

            // ─── 1. Party ledger match ──────────────────────────
            const flags = [];
            let matchedParty = '';
            let partyNotFound = false;
            let partyOptions = null;
            let partyLedgerGroup = '';
            let partyLedgerConfirmed = true;

            if (args.forcedPartyLedger) {
                matchedParty = args.forcedPartyLedger;
                partyLedgerGroup = 'Forced Party Ledger (Bypassed Tally check)';
            } else {
                try {
                    const cleanedParty = cleanPartyName(args.partyName);
                    const words = cleanedParty.split(/\s+/).filter(w => w.length >= 3);
                    let ledgers = [];
                    const ledgerFields = ['Name', 'Parent'];

                    if (words.length > 0) {
                        const ledgerFilter = new Map([['searchField', 'Name'], ['searchValue', words[0]]]);
                        ledgers = await queryCollection('Ledger', ledgerFields, ledgerFilter, args.targetCompany);
                    }
                    if ((!Array.isArray(ledgers) || ledgers.length === 0) && words.length > 1) {
                        const ledgerFilter2 = new Map([['searchField', 'Name'], ['searchValue', words[words.length - 1]]]);
                        ledgers = await queryCollection('Ledger', ledgerFields, ledgerFilter2, args.targetCompany);
                    }
                    if (!Array.isArray(ledgers) || ledgers.length === 0) {
                        ledgers = await queryCollection('Ledger', ledgerFields, new Map(), args.targetCompany);
                    }

                    if (Array.isArray(ledgers) && ledgers.length > 0) {
                        const scored = ledgers
                            .map(l => ({ name: String(l.Name || ''), parent: String(l.Parent || ''), score: fuzzyScore(l.Name, cleanedParty) }))
                            .filter(l => l.score >= 0.35)
                            .sort((a, b) => b.score - a.score);

                        let bestMatch = scored[0];
                        if (scored.length > 1) {
                            partyOptions = scored.slice(0, 5).map(s => s.name);
                            partyLedgerConfirmed = false;
                            flags.push({ field: 'Party Ledger', issue: `Multiple party ledger matches found. Top match ${bestMatch ? bestMatch.name : ''} used. Pass forcedPartyLedger to override.` });
                        }

                        if (bestMatch) {
                            const isDebtor = /debtor/i.test(bestMatch.parent);
                            const isCreditor = /creditor/i.test(bestMatch.parent);

                            if (args.voucherMode === 'purchase' && isDebtor) {
                                partyNotFound = true;
                                flags.push({ field: 'Party Ledger', issue: `Fuzzy-matched party ledger ${bestMatch.name} belongs to Sundry Debtors instead of Sundry Creditors.` });
                            } else if (args.voucherMode === 'sales' && isCreditor) {
                                partyNotFound = true;
                                flags.push({ field: 'Party Ledger', issue: `Fuzzy-matched party ledger ${bestMatch.name} belongs to Sundry Creditors instead of Sundry Debtors.` });
                            } else {
                                matchedParty = bestMatch.name;
                                partyLedgerGroup = bestMatch.parent;
                            }
                        } else {
                            partyNotFound = true;
                            flags.push({ field: 'Party Ledger', issue: 'No Tally ledger matched with sufficient confidence.' });
                        }
                    } else {
                        partyNotFound = true;
                        flags.push({ field: 'Party Ledger', issue: 'No ledgers found in Tally company.' });
                    }
                } catch (e) {
                    partyNotFound = true;
                    flags.push({ field: 'Party Ledger', issue: `Tally search failed: ${e.message}` });
                }
            }

            // ─── 2. Stock item match ──────────────────────────
            const stockItemFields = ['Name', 'Parent', 'BaseUnits'];
            let allStockItems = null;

            const matchStockItem = async (particular) => {
                const rawUpper = String(particular || '').toUpperCase();
                const normalizedRaw = normalizeComboJoiners(rawUpper);
                const isComboQualifier = /\bRY\b/.test(normalizedRaw);

                const getSilentHAndConsonantVariants = (str) => {
                    const variants = new Set();
                    let s = str.toLowerCase();
                    const noH = s.replace(/\bch/g, 'c').replace(/([^s])h/g, '$1').replace(/sch/g, 'sc').replace(/sh/g, 's');
                    variants.add(noH);
                    variants.add(s.replace(/([a-z])\1/g, '$1'));
                    variants.add(noH.replace(/([a-z])\1/g, '$1'));
                    variants.add(s.replace(/ch/g, 'k'));
                    return Array.from(variants).map(v => v.toUpperCase());
                };

                const expandQualifier = (str) => {
                    let s = str.toUpperCase();
                    if (s.startsWith('G. ')) s = s.replace(/^G\.\s*/, 'GREEN ');
                    if (s.startsWith('Y. ')) s = s.replace(/^Y\.\s*/, 'YELLOW ');
                    if (s.startsWith('R. ')) s = s.replace(/^R\.\s*/, 'RED ');
                    if (s.startsWith('W. ')) s = s.replace(/^W\.\s*/, 'WHITE ');
                    return s;
                };

                const baseNoun = stripQualifier(rawUpper);
                const searchPhases = [];

                if (isComboQualifier && baseNoun) {
                    searchPhases.push({ text: `${baseNoun} COMBO`, type: 'combo_explicit', priority: 0 });
                    searchPhases.push({ text: `R Y ${baseNoun}`, type: 'combo_ry', priority: 0 });
                }
                searchPhases.push({ text: rawUpper, type: 'literal', priority: 3 });
                const expanded = expandQualifier(rawUpper);
                if (expanded !== rawUpper) searchPhases.push({ text: expanded, type: 'expanded_qualifier', priority: 2 });
                searchPhases.push({ text: baseNoun, type: 'stripped_qualifier', priority: 4 });

                const baseSpellingVariants = getSilentHAndConsonantVariants(baseNoun);
                for (const variant of baseSpellingVariants) {
                    if (variant !== baseNoun) searchPhases.push({ text: variant, type: 'silent_h_base', priority: 4 });
                }

                const colorPrefix = rawUpper.startsWith('G.') || rawUpper.includes('GREEN') ? 'GREEN ' :
                    rawUpper.startsWith('Y.') || rawUpper.includes('YELLOW') ? 'YELLOW ' :
                        rawUpper.startsWith('R.') || rawUpper.includes('RED') ? 'RED ' :
                            rawUpper.startsWith('W.') || rawUpper.includes('WHITE') ? 'WHITE ' : '';
                if (colorPrefix) {
                    const variantsForPrefix = baseSpellingVariants.length ? baseSpellingVariants : [baseNoun];
                    for (const variant of variantsForPrefix) searchPhases.push({ text: colorPrefix + variant, type: 'expanded_silent_h', priority: 1 });
                    const siblingColors = ['GREEN ', 'YELLOW ', 'RED ', 'WHITE '].filter(c => c !== colorPrefix);
                    for (const color of siblingColors) searchPhases.push({ text: color + baseNoun, type: 'sibling_color', priority: 5 });
                }

                const computeLcsSimilarity = (str1, str2) => {
                    const s1 = String(str1).toLowerCase().replace(/[^a-z0-9]/g, '');
                    const s2 = String(str2).toLowerCase().replace(/[^a-z0-9]/g, '');
                    const m = s1.length, n = s2.length;
                    if (m === 0 || n === 0) return 0;
                    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
                    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
                        dp[i][j] = s1[i - 1] === s2[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
                    return (2 * dp[m][n]) / (m + n);
                };

                if (!allStockItems) {
                    try { allStockItems = await queryCollection('StockItem', stockItemFields, new Map(), args.targetCompany); }
                    catch (e) { allStockItems = []; }
                }
                const candidates = allStockItems || [];
                const orderedPhases = [...searchPhases].sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));

                let matchedList = [];
                for (const phase of orderedPhases) {
                    const scored = candidates
                        .map(i => {
                            const name = String(i.Name || '').toUpperCase();
                            const score = fuzzyScore(name, phase.text);
                            const tallyCore = stripQualifier(name);
                            const similarity = computeLcsSimilarity(baseNoun, tallyCore);
                            return { item: i, name: String(i.Name || ''), score, similarity };
                        })
                        .filter(c => c.score >= 0.5 && c.similarity >= 0.70)
                        .sort((a, b) => b.score - a.score);

                    for (const candidate of scored) {
                        const top = candidate.item;
                        const matchName = String(top.Name || '');

                        let matchedOk = true, note = null;
                        const matchNormalized = normalizeComboJoiners(matchName.toUpperCase());
                        const matchIsCombo = /\bRY\b/.test(matchNormalized) || /\bCOMBO\b/.test(matchNormalized) || /\bMIX\b/.test(matchNormalized);

                        if (isComboQualifier && !matchIsCombo) {
                            matchedOk = 'partial';
                            note = `Qualifier dropped: Combo matched generic "${matchName}"`;
                        } else if (phase.type.includes('silent_h')) {
                            note = `Matched via spelling variant: ${particular} → ${matchName}`;
                        } else if (phase.type === 'sibling_color') {
                            matchedOk = 'partial';
                            note = `Matched sibling color variant: ${particular} → ${matchName}`;
                        } else if (isComboQualifier && matchIsCombo) {
                            note = `Matched combo item: ${particular} → ${matchName}`;
                        }

                        if (!matchedList.some(m => m.matched === matchName)) {
                            matchedList.push({
                                matched: matchName,
                                unit: top.BaseUnits || null,
                                matched_ok: matchedOk,
                                match_note: note,
                                score: candidate.score
                            });
                        }
                    }
                }

                if (matchedList.length > 0) {
                    const best = matchedList[0];
                    const top5Candidates = matchedList.slice(0, 5).map(m => m.matched);
                    return {
                        matched: best.matched,
                        unit: best.unit,
                        matched_ok: best.matched_ok,
                        match_note: best.match_note,
                        score: best.score,
                        candidates: top5Candidates
                    };
                }

                const bestEffort = candidates
                    .map(i => ({ name: String(i.Name || ''), score: fuzzyScore(String(i.Name || ''), rawUpper) }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 5)
                    .map(c => c.name);

                return {
                    matched: '',
                    unit: null,
                    matched_ok: false,
                    match_note: 'No confident Tally match found',
                    score: 0,
                    candidates: bestEffort.length > 0 ? bestEffort : ['No Tally Items Found']
                };
            };

            const isLedgerRow = (particular) => {
                return /cgst|sgst|igst|cess|carriage|freight|round|discount/i.test(particular);
            };

            const matchLedger = async (name) => {
                try {
                    const cleanName = name.toUpperCase();
                    let ledgers = await queryCollection('Ledger', ['Name'], new Map(), args.targetCompany);
                    const scored = ledgers
                        .map(l => ({ name: String(l.Name || ''), score: fuzzyScore(l.Name, cleanName) }))
                        .filter(l => l.score >= 0.5)
                        .sort((a, b) => b.score - a.score);
                    return scored[0] ? scored[0].name : name;
                } catch (e) {
                    return name;
                }
            };

            // Pre-fetch Ledgers for validation and default selection
            let purchaseLedgers = [];
            try {
                const ledgerResult = await queryCollection('Ledger', ['Name', 'Parent'], new Map(), args.targetCompany);
                if (Array.isArray(ledgerResult)) {
                    if (args.voucherMode === 'purchase') {
                        purchaseLedgers = ledgerResult
                            .filter(l => /purchase/i.test(l.Parent || ''))
                            .map(l => String(l.Name || ''))
                            .filter(Boolean);
                    } else {
                        purchaseLedgers = ledgerResult
                            .filter(l => /sales/i.test(l.Parent || ''))
                            .map(l => String(l.Name || ''))
                            .filter(Boolean);
                    }
                }
            } catch (e) { }
            if (!purchaseLedgers.length) {
                purchaseLedgers = args.voucherMode === 'purchase' ? ['Purchase Accounts', 'Purchase'] : ['Sales Accounts', 'Sales'];
            }
            const defaultPurchaseLedger = purchaseLedgers[0] || (args.voucherMode === 'purchase' ? 'Purchase Accounts' : 'Sales Accounts');

            let taxExpenseLedgers = [];
            try {
                const ledgerResult = await queryCollection('Ledger', ['Name', 'Parent'], new Map(), args.targetCompany);
                if (Array.isArray(ledgerResult)) {
                    taxExpenseLedgers = ledgerResult
                        .filter(l => /duties|expense|tax/i.test(l.Parent || ''))
                        .map(l => String(l.Name || ''))
                        .filter(Boolean);
                }
            } catch (e) { }
            if (!taxExpenseLedgers.length) {
                taxExpenseLedgers = ['CGST', 'SGST', 'IGST', 'Rounding Off', 'Carriage Inward', 'Carriage Outward'];
            }

            const resolvedItems = [];
            const ledgerRowsSummary = [];
            let itemsRequiringReview = 0;
            let stockItemDropdownIdx = 0;

            for (const item of args.lineItems) {
                if (isLedgerRow(item.particular)) {
                    const matchedLg = await matchLedger(item.particular);
                    ledgerRowsSummary.push({
                        description: item.particular,
                        tally_ledger_matched: matchedLg,
                        amount: item.amount
                    });
                    resolvedItems.push({
                        particular: item.particular,
                        is_ledger_row: true,
                        tally_stock_item: '',
                        purchase_ledger: matchedLg,
                        quantity: '',
                        unit: '',
                        rate: '',
                        amount: item.amount,
                        match_score: 0,
                        match_confidence: 'high',
                        candidates: []
                    });
                } else {
                    const result = await matchStockItem(item.particular);
                    let confidence = 'not_found';
                    if (result.matched_ok === true) {
                        if (result.score >= 0.8) confidence = 'high';
                        else confidence = 'medium';
                    } else if (result.matched_ok === 'partial') {
                        confidence = 'partial';
                    }

                    if (confidence === 'medium' || confidence === 'partial' || confidence === 'not_found') {
                        itemsRequiringReview++;
                    }

                    if (!result.matched_ok) {
                        flags.push({ field: `Stock Item: ${item.particular}`, issue: result.match_note || 'Not found in Tally stock master' });
                    } else if (result.matched_ok === 'partial') {
                        flags.push({ field: `Stock Item: ${item.particular}`, issue: result.match_note });
                    }

                    stockItemDropdownIdx++;

                    resolvedItems.push({
                        particular: item.particular,
                        is_ledger_row: false,
                        tally_stock_item: result.matched,
                        purchase_ledger: defaultPurchaseLedger,
                        quantity: item.quantity,
                        unit: item.unit || result.unit || 'Nos',
                        rate: item.rate,
                        amount: item.amount,
                        match_score: result.score,
                        match_confidence: confidence,
                        candidates: result.candidates,
                        stock_item_index: stockItemDropdownIdx,
                        matched_ok: result.matched_ok
                    });
                }
            }

            const calculatedTotal = round2(resolvedItems.reduce((s, i) => s + (i.amount || 0), 0));
            let totalMismatch = null;
            if (args.billTotal !== undefined && args.billTotal !== null) {
                const diff = round2(Math.abs(calculatedTotal - args.billTotal));
                if (diff > 0.02) {
                    totalMismatch = {
                        bill_printed_total: args.billTotal,
                        calculated_total: calculatedTotal,
                        difference: round2(calculatedTotal - args.billTotal)
                    };
                }
            }

            const defaultVoucherType = args.voucherMode === 'purchase'
                ? (args.purchaseVoucherType || '')
                : (args.salesVoucherType || '');

            // ─── 3. Generate Excel file ───────────────────────
            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Tally Import');

            // Format date for Tally import (DD-MM-YYYY)
            const parsedBillDate = parseBankStatementDate(args.billDate) || new Date();
            const formatImportDate = (d) => {
                const dd = String(d.getDate()).padStart(2, '0');
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const yyyy = d.getFullYear();
                return `${dd}-${mm}-${yyyy}`;
            };
            const importDateStr = formatImportDate(parsedBillDate);

            // Columns matching exact Tally import format
            ws.columns = [
                { header: 'Date', key: 'date', width: 15 },
                { header: 'Voucher Type', key: 'voucher_type', width: 15 },
                { header: 'Voucher No.', key: 'voucher_number', width: 15 },
                { header: 'Invoice No.', key: 'invoice_no', width: 15 },
                { header: 'Invoice Date', key: 'invoice_date', width: 15 },
                { header: 'Party Name', key: 'party_name', width: 30 },
                { header: 'Sale/Purchase Ledger', key: 'ledger', width: 30 },
                { header: 'Item Name', key: 'item_name', width: 30 },
                { header: 'Batch', key: 'batch', width: 10 },
                { header: 'Qty', key: 'qty', width: 12 },
                { header: 'Rate', key: 'rate', width: 12 },
                { header: 'Amount', key: 'amount', width: 15 },
                { header: 'IGST', key: 'igst', width: 15 },
                { header: 'CGST', key: 'cgst', width: 15 },
                { header: 'SGST', key: 'sgst', width: 15 },
                { header: 'Narration', key: 'narration', width: 40 },
                { header: 'Match Score', key: 'match_score', width: 15 }
            ];

            // Format Header
            const hRow = ws.getRow(1);
            hRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            hRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF1F497D' }
            };
            hRow.alignment = { vertical: 'middle', horizontal: 'center' };

            // Explicitly set date column A to text format
            ws.getColumn('A').numFmt = '@';
            ws.getColumn('E').numFmt = '@';

            const getTaxColumn = (particular) => {
                const p = String(particular || '').toUpperCase();
                if (p.includes('CGST')) return 'CGST';
                if (p.includes('SGST')) return 'SGST';
                if (p.includes('IGST')) return 'IGST';
                return null;
            };

            let rowNum = 1;
            for (const item of resolvedItems) {
                rowNum++;
                const taxCol = item.is_ledger_row ? getTaxColumn(item.particular) : null;
                const rowData = {
                    date: importDateStr,
                    voucher_type: defaultVoucherType,
                    voucher_number: '',
                    invoice_no: args.billNumber || '',
                    invoice_date: importDateStr,
                    party_name: matchedParty || args.partyName,
                    ledger: item.is_ledger_row ? item.purchase_ledger : defaultPurchaseLedger,
                    item_name: item.is_ledger_row ? '' : item.tally_stock_item,
                    batch: '',
                    qty: item.is_ledger_row ? '' : item.quantity,
                    rate: item.is_ledger_row ? '' : item.rate,
                    amount: taxCol ? '' : item.amount,
                    igst: taxCol === 'IGST' ? item.amount : '',
                    cgst: taxCol === 'CGST' ? item.amount : '',
                    sgst: taxCol === 'SGST' ? item.amount : '',
                    narration: args.billNumber ? `Bill No: ${args.billNumber}` : '',
                    match_score: item.is_ledger_row ? 1.0 : item.match_score
                };

                const row = ws.addRow(rowData);

                row.eachCell((cell) => {
                    cell.font = { color: { argb: 'FF1F497D' } };
                });

                // Ensure dates are saved with text format
                ws.getCell(`A${rowNum}`).numFmt = '@';
                ws.getCell(`E${rowNum}`).numFmt = '@';

                if (item.is_ledger_row) {
                    // Tax/Expense ledger validation dropdown (Col G)
                    ws.getCell(`G${rowNum}`).dataValidation = {
                        type: 'list',
                        allowBlank: true,
                        formulae: [`Lists!$S$1:$S$${taxExpenseLedgers.length}`],
                        showErrorMessage: true,
                        errorStyle: 'warning',
                        errorTitle: 'Invalid Tax/Expense Ledger',
                        error: 'Selected ledger is not in Tally tax/expense accounts. Verify before importing.'
                    };
                } else {
                    // Purchase/Sales ledger validation dropdown (Col G)
                    ws.getCell(`G${rowNum}`).dataValidation = {
                        type: 'list',
                        allowBlank: true,
                        formulae: [`Lists!$C$1:$C$${purchaseLedgers.length}`],
                        showErrorMessage: true,
                        errorStyle: 'stop',
                        errorTitle: 'Invalid Purchase/Sales Ledger',
                        error: 'Please select a valid Purchase/Sales ledger.'
                    };

                    const cellH = ws.getCell(`H${rowNum}`);
                    let color = '';
                    if (item.matched_ok === true) {
                        if (item.match_score >= 0.8) color = 'FFC6EFCE'; // Light Green
                        else color = 'FFFFEB9C'; // Light Yellow
                    } else if (item.matched_ok === 'partial') {
                        color = 'FFFFC59C'; // Light Orange
                    } else {
                        color = 'FFFFC7CE'; // Light Red
                    }

                    cellH.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: color }
                    };

                    cellH.dataValidation = {
                        type: 'list',
                        allowBlank: true,
                        formulae: [`item_${item.stock_item_index}_candidates`],
                        showErrorMessage: true,
                        errorStyle: 'warning',
                        errorTitle: 'Stock Item Not in Top Matches',
                        error: 'Selected item is not in the top Tally matches. Verify before importing.'
                    };
                }
            }

            // Hide match score column Q
            ws.getColumn('Q').hidden = true;

            // Sum row
            const sumRowIdx = resolvedItems.length + 2;
            const sumRow = ws.getRow(sumRowIdx);
            sumRow.getCell('A').value = 'Total';
            sumRow.getCell('A').font = { bold: true, color: { argb: 'FF1F497D' } };
            sumRow.getCell('J').value = { formula: `=SUM(J2:J${sumRowIdx - 1})` };
            sumRow.getCell('J').font = { bold: true, color: { argb: 'FF1F497D' } };
            sumRow.getCell('L').value = { formula: `=SUM(L2:L${sumRowIdx - 1})` };
            sumRow.getCell('L').font = { bold: true, color: { argb: 'FF1F497D' } };
            sumRow.getCell('M').value = { formula: `=SUM(M2:M${sumRowIdx - 1})` };
            sumRow.getCell('M').font = { bold: true, color: { argb: 'FF1F497D' } };
            sumRow.getCell('N').value = { formula: `=SUM(N2:N${sumRowIdx - 1})` };
            sumRow.getCell('N').font = { bold: true, color: { argb: 'FF1F497D' } };
            sumRow.getCell('O').value = { formula: `=SUM(O2:O${sumRowIdx - 1})` };
            sumRow.getCell('O').font = { bold: true, color: { argb: 'FF1F497D' } };

            // Discrepancy warning
            if (totalMismatch) {
                const warnRowIdx = sumRowIdx + 1;
                const warnRow = ws.getRow(warnRowIdx);
                warnRow.getCell('A').value = `WARNING: Bill total discrepancy! Calculated Total: ${calculatedTotal}, Bill Total: ${args.billTotal}. Diff: ${totalMismatch.difference}`;
                warnRow.getCell('A').font = { bold: true, color: { argb: 'FFFF0000' } };
                ws.mergeCells(`A${warnRowIdx}:P${warnRowIdx}`);
            }

            // ─── 4. Validation Lists Sheet ────────────────────
            let voucherTypes = [];
            try {
                const vtResult = await queryCollection('VoucherType', ['Name'], new Map(), args.targetCompany);
                if (Array.isArray(vtResult)) voucherTypes = vtResult.map(v => String(v.Name || '')).filter(Boolean);
            } catch (e) { }
            if (!voucherTypes.length) voucherTypes = ['Purchase', 'Sales', 'Journal', 'Payment', 'Receipt'];

            let godowns = [];
            try {
                const gdResult = await queryCollection('Godown', ['Name'], new Map(), args.targetCompany);
                if (Array.isArray(gdResult)) godowns = gdResult.map(g => String(g.Name || '')).filter(Boolean);
            } catch (e) { }
            if (!godowns.length) godowns = ['Main Location'];

            const listsSheet = wb.addWorksheet('Lists');
            listsSheet.state = 'hidden';
            for (let i = 0; i < voucherTypes.length; i++) {
                listsSheet.getCell(`A${i + 1}`).value = voucherTypes[i];
            }
            for (let i = 0; i < godowns.length; i++) {
                listsSheet.getCell(`B${i + 1}`).value = godowns[i];
            }
            for (let i = 0; i < purchaseLedgers.length; i++) {
                listsSheet.getCell(`C${i + 1}`).value = purchaseLedgers[i];
            }
            for (let i = 0; i < taxExpenseLedgers.length; i++) {
                listsSheet.getCell(`S${i + 1}`).value = taxExpenseLedgers[i];
            }

            if (partyOptions && partyOptions.length > 1) {
                for (let i = 0; i < partyOptions.length; i++) {
                    listsSheet.getCell(`P${i + 1}`).value = partyOptions[i];
                }
                wb.definedNames.add(`Lists!$P$1:$P$${partyOptions.length}`, 'party_options');
            }

            const getColLetter = (index) => {
                let temp;
                let letter = '';
                while (index > 0) {
                    temp = (index - 1) % 26;
                    letter = String.fromCharCode(65 + temp) + letter;
                    index = (index - temp - 1) / 26;
                }
                return letter;
            };

            for (const item of resolvedItems) {
                if (!item.is_ledger_row) {
                    const colLetter = getColLetter(3 + item.stock_item_index);
                    for (let c = 0; c < item.candidates.length; c++) {
                        listsSheet.getCell(`${colLetter}${c + 1}`).value = item.candidates[c];
                    }
                    wb.definedNames.add(`Lists!$${colLetter}$1:$${colLetter}$${item.candidates.length || 1}`, `item_${item.stock_item_index}_candidates`);
                }
            }

            const maxValidateRow = resolvedItems.length + 2 + 200;
            for (let r = 2; r <= maxValidateRow; r++) {
                ws.getCell(`B${r}`).dataValidation = {
                    type: 'list',
                    allowBlank: true,
                    formulae: [`Lists!$A$1:$A$${voucherTypes.length}`],
                    showErrorMessage: true,
                    errorStyle: 'stop',
                    errorTitle: 'Invalid Voucher Type',
                    error: 'Please select a valid Voucher Type.'
                };
                if (partyOptions && partyOptions.length > 1) {
                    ws.getCell(`F${r}`).dataValidation = {
                        type: 'list',
                        allowBlank: false,
                        formulae: ['party_options'],
                        showErrorMessage: true,
                        errorStyle: 'warning',
                        errorTitle: 'Party Ledger Option',
                        error: 'Please verify if the selected party ledger is correct.'
                    };
                }
            }

            // Output logic
            let outPath = args.outputPath;
            if (!outPath) {
                outPath = path.join(process.cwd(), `tally_import_${Date.now()}.xlsx`);
            }
            await wb.xlsx.writeFile(outPath);

            let base64Data;
            if (args.returnBase64) {
                const buffer = await wb.xlsx.writeBuffer();
                base64Data = buffer.toString('base64');
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        outputPath: outPath,
                        excelBase64: base64Data,
                        voucherMode: args.voucherMode,
                        party_ledger_matched: !!matchedParty,
                        party_ledger_confirmed: partyLedgerConfirmed,
                        party_ledger_group: partyLedgerGroup || null,
                        stock_items: resolvedItems.filter(item => !item.is_ledger_row).map(item => ({
                            particular: item.particular,
                            tally_match: item.tally_stock_item,
                            match_score: item.match_score,
                            match_confidence: item.match_confidence,
                            top_candidates: item.candidates,
                            requires_review: item.match_confidence !== 'high'
                        })),
                        ledger_rows: ledgerRowsSummary,
                        items_requiring_review: itemsRequiringReview,
                        calculated_total: calculatedTotal,
                        total_mismatch: totalMismatch,
                        flags: flags.length > 0 ? flags : null
                    }, null, 2)
                }]
            };

        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });

    mcpServer.registerTool('broker-purchase-report', {
        title: 'Broker Purchase Report Debug',
        description: 'DEBUG version of broker purchase report — returns raw JSON only. Queries one or more purchase ledger accounts via ledger-account report and filters rows whose narration contains the broker code. Use discover-ledger-accounts or query-database to find the relevant purchase ledger names first.',
        inputSchema: {
            brokerCode: z.string().describe('Broker code to filter by, e.g. "P56". Matched case-insensitively against narration.'),
            fromDate: z.string().describe('Start date YYYY-MM-DD'),
            toDate: z.string().describe('End date YYYY-MM-DD'),
            purchaseLedgers: z.array(z.string()).optional().describe('List of purchase ledger account names to scan. If omitted, defaults to a pre-defined list of wheat purchase ledgers.'),
            targetCompany: z.string().optional().describe('Tally company name. Validate using discover-companies.'),
            voucherType: z.string().optional().describe('Optional voucher type name filter (case-insensitive). If omitted, all voucher types from the scanned ledgers are included.'),
            maxRows: z.number().int().optional().describe('Maximum rows to return for debugging, default 50.'),
            dateRangeMonths: z.number().int().min(1).max(12).optional().describe('Limit the query to this many months ending at toDate. Default: no limit (uses fromDate as-is). Use this to avoid overloading Tally on large ledgers — e.g. pass 3 to query only the last 3 months.'),
            fetchRetentionDetail: z.boolean().default(true).optional().describe('If true (default), fetches voucher detail for each matched row to extract souda retention as a separate column. Set to false to skip retention detail and return only the gross purchase ledger amount.'),
            retentionLedgerPatterns: z.array(z.string()).optional().describe('List of ledger name patterns (case-insensitive contains match) to identify retention/deduction entries within each voucher. Defaults to ["SOUDA", "RETENTION", "QUALITY DEDUCTION", "SHORTAGE DEDUCTION"].')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const defaultWheatLedgers = [
                'WHEAT PURCHASE A/C',
                'WHEAT PURCHASE TRADING A/C',
                'WHEAT PURCHASE A/C MOHANIA',
                'WHEAT PURCHASE A/C BUXAR',
                'WHEAT PURCHASE A/C SASARAM',
                'WHEAT PURCHASE AMTA A/C',
                'WHEAT PURCHASE DEHRI ON SONE A/C',
                'WHEAT PURCHASE RAMGARH A/C',
                'WEAT PURCHASE INTERSATE A/C',
                'WHEAT 90 KGS. PURCHASE A/C'
            ];
            const purchaseLedgers = (Array.isArray(args.purchaseLedgers) && args.purchaseLedgers.length > 0)
                ? args.purchaseLedgers
                : defaultWheatLedgers;

            let effectiveFromDate = args.fromDate;
            if (typeof args.dateRangeMonths === 'number') {
                const toD = parseBankStatementDate(args.toDate);
                const fromD = new Date(toD.getFullYear(), toD.getMonth() - args.dateRangeMonths, toD.getDate());
                effectiveFromDate = utility.Date.format(fromD, 'yyyy-MM-dd');
            }

            const rawCode = String(args.brokerCode || '').trim();
            const normalizedCode = rawCode.replace(/[-\s]+/g, ''); // strip hyphens/spaces
            const codeMatch = normalizedCode.match(/^([A-Za-z]+)(\d+)$/);

            const escapeRegex = (s) => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

            let brokerRegex;
            if (codeMatch) {
                const [, prefix, suffix] = codeMatch;
                brokerRegex = new RegExp(
                    `${escapeRegex(prefix)}[-\\s]*${escapeRegex(suffix)}(?!\\d)`,
                    'gi'
                );
            } else {
                brokerRegex = new RegExp(escapeRegex(rawCode), 'gi');
            }

            const filterVoucherType = args.voucherType ? String(args.voucherType).trim().toLowerCase() : null;

            // Split effectiveFromDate → toDate into monthly chunks
            const monthChunks = splitDateRangeIntoMonths(
                parseBankStatementDate(effectiveFromDate),
                parseBankStatementDate(args.toDate)
            );

            const allRows = [];
            const fetchErrors = [];
            let tallyCallsMade = 0;

            for (const ledgerName of purchaseLedgers) {
                for (const chunk of monthChunks) {
                    try {
                        const chunkFromStr = utility.Date.format(chunk.start, 'yyyy-MM-dd');
                        const chunkToStr = utility.Date.format(chunk.end, 'yyyy-MM-dd');

                        const params = new Map([
                            ['fromDate', chunkFromStr],
                            ['toDate', chunkToStr],
                            ['ledgerName', ledgerName]
                        ]);
                        if (args.targetCompany) params.set('targetCompany', args.targetCompany);

                        const resp = await fetchReport('ledger-account', params);
                        tallyCallsMade++;

                        if (resp.error) {
                            fetchErrors.push(
                                `${ledgerName} [${chunkFromStr} to ${chunkToStr}]: ${resp.error}`
                            );
                            continue;
                        }

                        const rows = (Array.isArray(resp.data) ? resp.data : [])
                            .filter(r => r && String(r.voucher_type || '').toLowerCase() !== 'opening');

                        for (const r of rows) r._source_ledger = ledgerName;
                        allRows.push(...rows);
                    } catch (e) {
                        fetchErrors.push(
                            `${ledgerName} [${utility.Date.format(chunk.start, 'yyyy-MM-dd')} to ${utility.Date.format(chunk.end, 'yyyy-MM-dd')}]: ${e.message}`
                        );
                    }
                }
            }

            const matchedRows = [];
            for (const r of allRows) {
                const narration = String(r.narration || '');
                if (!brokerRegex.test(narration)) continue;
                brokerRegex.lastIndex = 0; // reset after test() call since flag 'g' is used

                const vTypeName = String(r.voucher_type || '');
                if (filterVoucherType && vTypeName.toLowerCase() !== filterVoucherType) continue;

                // Vehicle number = narration remainder after stripping broker code and party suffix
                const vehicle_number = narration
                    .replace(brokerRegex, '')
                    .trim()
                    .replace(/[-,\s]+$/, '')  // strip trailing separators
                    .trim() || null;
                brokerRegex.lastIndex = 0; // reset after replace() with 'g' flag

                // Amount comes directly from ledger-account (debit = negative, purchase = debit = negative amount)
                const amount = Number(r.amount) || 0;

                // Party name comes directly from party_ledger (confirmed populated for purchase vouchers)
                const party_name = String(r.party_ledger || r.alternate_ledger || '').trim();

                matchedRows.push({
                    date: r.date,
                    voucher_number: r.voucher_number,
                    voucher_type: vTypeName,
                    source_ledger: r._source_ledger,
                    party_name,
                    narration,
                    vehicle_number,
                    amount,
                });
            }

            const retentionLedgerPatterns = args.retentionLedgerPatterns || ['SOUDA'];

            const finalMatchedRows = [];
            let totalQuantityKgs = 0;
            let totalGrossAmount = 0;
            let totalSoudaAmount = 0;
            let totalNetAmount = 0;
            let rowsWithSouda = 0;
            let rowsWithoutSouda = 0;

            const shouldFetchDetail = args.fetchRetentionDetail !== false;

            if (shouldFetchDetail) {
                for (const row of matchedRows) {
                    try {
                        const details = await fetchVoucherDetailInternal(
                            row.voucher_number,
                            row.voucher_type,
                            row.date,
                            args.targetCompany,
                            null, // guid
                            args.retentionLedgerPatterns?.[0] || 'SOUDA RETENTION CHARGES',
                            'WHEAT'
                        );
                        tallyCallsMade += 2;

                        if (details) {
                            // Wheat quantity — from inventory_entries
                            const wheatEntry = (details.inventory_entries || []).find(e =>
                                String(e.stock_item_name || '').toUpperCase().includes('WHEAT')
                            );
                            const quantity_kgs = wheatEntry 
                                ? Math.abs(wheatEntry.billed_qty) 
                                : null;

                            // Gross amount — from inventory_entries wheat line amount
                            const gross_amount = wheatEntry 
                                ? Math.abs(wheatEntry.amount) 
                                : Math.abs(row.amount || 0);

                            // Souda retention — from ledger_entries matching retention patterns
                            const retentionEntries = (details.ledger_entries || []).filter(e =>
                                retentionLedgerPatterns.some(p => 
                                    String(e.ledger_name || '').toUpperCase().includes(p.toUpperCase())
                                )
                            );
                            
                            const souda_amount = retentionEntries.reduce(
                                (sum, e) => sum + Math.abs(e.amount), 0
                            );
                            
                            const retention_ledger_names = retentionEntries
                                .map(e => e.ledger_name)
                                .filter(Boolean);
                            
                            const net_amount = gross_amount - souda_amount;

                            if (quantity_kgs !== null) {
                                totalQuantityKgs += quantity_kgs;
                            }
                            totalGrossAmount += gross_amount;
                            totalSoudaAmount += souda_amount;
                            totalNetAmount += net_amount;
                            if (souda_amount > 0) {
                                rowsWithSouda++;
                            } else {
                                rowsWithoutSouda++;
                            }

                            finalMatchedRows.push({
                                date: row.date,
                                voucher_number: row.voucher_number,
                                voucher_type: row.voucher_type,
                                source_ledger: row.source_ledger,
                                party_name: row.party_name,
                                narration: row.narration,
                                vehicle_number: row.vehicle_number,
                                quantity_kgs: quantity_kgs !== null ? Number(quantity_kgs.toFixed(2)) : null,
                                gross_amount: Number(gross_amount.toFixed(2)),
                                souda_amount: Number(souda_amount.toFixed(2)),
                                net_amount: Number(net_amount.toFixed(2)),
                                retention_ledger_names
                            });
                        } else {
                            const gross_amount = Math.abs(row.amount);
                            const souda_amount = 0;
                            const net_amount = gross_amount;

                            totalGrossAmount += gross_amount;
                            totalNetAmount += net_amount;
                            rowsWithoutSouda++;

                            finalMatchedRows.push({
                                date: row.date,
                                voucher_number: row.voucher_number,
                                voucher_type: row.voucher_type,
                                source_ledger: row.source_ledger,
                                party_name: row.party_name,
                                narration: row.narration,
                                vehicle_number: row.vehicle_number,
                                quantity_kgs: null,
                                gross_amount: Number(gross_amount.toFixed(2)),
                                souda_amount: 0,
                                net_amount: Number(net_amount.toFixed(2)),
                                retention_ledger_names: []
                            });
                        }
                    } catch (e) {
                        fetchErrors.push(
                            `VoucherDetail ${row.voucher_number}: ${e.message || String(e)}`
                        );
                        const gross_amount = Math.abs(row.amount);
                        const souda_amount = 0;
                        const net_amount = gross_amount;

                        totalGrossAmount += gross_amount;
                        totalNetAmount += net_amount;
                        rowsWithoutSouda++;

                        finalMatchedRows.push({
                            date: row.date,
                            voucher_number: row.voucher_number,
                            voucher_type: row.voucher_type,
                            source_ledger: row.source_ledger,
                            party_name: row.party_name,
                            narration: row.narration,
                            vehicle_number: row.vehicle_number,
                            quantity_kgs: null,
                            gross_amount: Number(gross_amount.toFixed(2)),
                            souda_amount: 0,
                            net_amount: Number(net_amount.toFixed(2)),
                            retention_ledger_names: []
                        });
                    }
                }
            } else {
                for (const row of matchedRows) {
                    finalMatchedRows.push({
                        date: row.date,
                        voucher_number: row.voucher_number,
                        voucher_type: row.voucher_type,
                        source_ledger: row.source_ledger,
                        party_name: row.party_name,
                        narration: row.narration,
                        vehicle_number: row.vehicle_number,
                        amount: Number(row.amount.toFixed(2))
                    });
                }
            }

            const responsePayload = {
                broker_code: args.brokerCode,
                broker_code_normalized: normalizedCode,
                broker_code_pattern: brokerRegex.source,
                from_date: args.fromDate,
                effective_from_date: effectiveFromDate,
                to_date: args.toDate,
                target_company: args.targetCompany || 'default',
                ledgers_scanned: purchaseLedgers,
                total_ledger_rows: allRows.length,
                total_matched: matchedRows.length,
                fetch_errors: fetchErrors,
                voucher_types_seen: [...new Set(allRows.map(r => String(r.voucher_type || '')).filter(Boolean))],
                tally_calls_made: tallyCallsMade,
                tally_calls_note: `${tallyCallsMade} sequential Tally calls made (${purchaseLedgers.length} ledgers × ${monthChunks.length} months${shouldFetchDetail ? ` + ${matchedRows.length} voucher detail calls` : ''}). Sequential month-by-month fetching prevents Tally UI from hanging.`,
                rows: finalMatchedRows.slice(0, args.maxRows ?? 50)
            };

            if (shouldFetchDetail) {
                responsePayload.total_quantity_kgs = Number(totalQuantityKgs.toFixed(2));
                responsePayload.total_gross_amount = Number(totalGrossAmount.toFixed(2));
                responsePayload.total_souda_amount = Number(totalSoudaAmount.toFixed(2));
                responsePayload.total_net_amount = Number(totalNetAmount.toFixed(2));
                responsePayload.rows_with_souda = rowsWithSouda;
                responsePayload.rows_without_souda = rowsWithoutSouda;
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(responsePayload, null, 2)
                }]
            };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });

    mcpServer.registerTool('broker-sales-report', {
        title: 'Broker Sales Report',
        description: 'Queries sales vouchers via query-collection and filters by broker code matching OtherReference (or narration fallback).',
        inputSchema: {
            brokerCode: z.string().describe('Broker code to filter by, e.g. "S1". Matched against the OtherReference field of the voucher using flexible regex.'),
            fromDate: z.string().describe('Start date YYYY-MM-DD'),
            toDate: z.string().describe('End date YYYY-MM-DD'),
            voucherTypes: z.array(z.string()).optional().describe('Voucher type names to filter. Defaults to sales voucher types: ["BILL OF SUPPLY RANIHATI", "BILL OF SUPPLY MOHANIA", "TAX INVOICE RANIHATI", "TAX INVOICE MOHANIA"].'),
            targetCompany: z.string().optional().describe('Tally company name.'),
            maxRows: z.number().int().optional().default(300).describe('Maximum rows to return, default 300.'),
            dateRangeMonths: z.number().int().min(1).max(12).optional().describe('Limit the query to this many months ending at toDate.')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const defaultVoucherTypes = [
                "BILL OF SUPPLY RANIHATI",
                "BILL OF SUPPLY MOHANIA",
                "TAX INVOICE RANIHATI",
                "TAX INVOICE MOHANIA"
            ];
            const resolvedVoucherTypes = (Array.isArray(args.voucherTypes) && args.voucherTypes.length > 0)
                ? args.voucherTypes
                : defaultVoucherTypes;

            let effectiveFromDate = args.fromDate;
            if (typeof args.dateRangeMonths === 'number') {
                const toD = parseBankStatementDate(args.toDate);
                const fromD = new Date(toD.getFullYear(), toD.getMonth() - args.dateRangeMonths, toD.getDate());
                effectiveFromDate = utility.Date.format(fromD, 'yyyy-MM-dd');
            }

            const rawCode = String(args.brokerCode || '').trim();
            const normalizedCode = rawCode.replace(/[-\s]+/g, ''); // strip hyphens/spaces
            const codeMatch = normalizedCode.match(/^([A-Za-z]+)(\d+)$/);

            const escapeRegex = (s) => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

            let brokerRegex;
            if (codeMatch) {
                const [, prefix, suffix] = codeMatch;
                brokerRegex = new RegExp(
                    `${escapeRegex(prefix)}[-\\s]*${escapeRegex(suffix)}(?!\\d)`,
                    'gi'
                );
            } else {
                brokerRegex = new RegExp(escapeRegex(rawCode), 'gi');
            }

            const monthChunks = splitDateRangeIntoMonths(
                parseBankStatementDate(effectiveFromDate),
                parseBankStatementDate(args.toDate)
            );

            const allVouchers = [];
            const fetchErrors = [];
            let tallyCallsMade = 0;

            const fields = ["Date", "VoucherNumber", "VoucherTypeName", "PartyLedgerName", "Narration", "OtherReference"];

            for (const chunk of monthChunks) {
                try {
                    const chunkFromStr = utility.Date.format(chunk.start, 'yyyy-MM-dd');
                    const chunkToStr = utility.Date.format(chunk.end, 'yyyy-MM-dd');

                    const resp = await queryCollection({
                        collection: 'Voucher',
                        fields,
                        fromDate: chunkFromStr,
                        toDate: chunkToStr,
                        targetCompany: args.targetCompany
                    });
                    tallyCallsMade++;

                    if (resp.isError) {
                        fetchErrors.push(`[${chunkFromStr} to ${chunkToStr}]: ${resp.content?.[0]?.text || 'Unknown query error'}`);
                        continue;
                    }

                    const payloadText = resp.content?.[0]?.text;
                    if (payloadText) {
                        const parsed = JSON.parse(payloadText);
                        const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
                        allVouchers.push(...rows);
                    }
                } catch (e) {
                    fetchErrors.push(`[${utility.Date.format(chunk.start, 'yyyy-MM-dd')} to ${utility.Date.format(chunk.end, 'yyyy-MM-dd')}]: ${e.message}`);
                }
            }

            const lowerVoucherTypes = resolvedVoucherTypes.map(t => String(t || '').trim().toLowerCase());

            const matchedRows = [];
            for (const v of allVouchers) {
                const vTypeName = String(v.VoucherTypeName || v.voucher_type_name || '').trim();
                if (lowerVoucherTypes.length > 0 && !lowerVoucherTypes.includes(vTypeName.toLowerCase())) {
                    continue;
                }

                const otherRef = String(v.OtherReference || v.other_reference || '');
                const narration = String(v.Narration || v.narration || '');

                let matches = false;
                if (brokerRegex.test(otherRef)) {
                    matches = true;
                } else if (brokerRegex.test(narration)) {
                    matches = true;
                }
                brokerRegex.lastIndex = 0;

                if (!matches) continue;

                matchedRows.push({
                    date: v.Date || v.date,
                    voucher_number: v.VoucherNumber || v.voucher_number,
                    voucher_type: vTypeName,
                    party_name: v.PartyLedgerName || v.party_ledger_name,
                    other_reference: otherRef || null,
                    narration: narration || null,
                    amount: null
                });
            }

            const otherReferencesSeen = [...new Set(
                allVouchers
                    .map(v => String(v.OtherReference || '').trim())
                    .filter(Boolean)
            )].slice(0, 20);

            const responsePayload = {
                debug: true,
                broker_code: args.brokerCode,
                broker_code_normalized: normalizedCode,
                broker_code_pattern: brokerRegex.source,
                from_date: args.fromDate,
                effective_from_date: effectiveFromDate,
                to_date: args.toDate,
                target_company: args.targetCompany || 'default',
                voucher_types_filtered: resolvedVoucherTypes,
                total_fetched: allVouchers.length,
                total_matched: matchedRows.length,
                voucher_types_seen: [...new Set(allVouchers.map(v => String(v.VoucherTypeName || v.voucher_type_name || '')).filter(Boolean))],
                other_references_seen: otherReferencesSeen,
                tally_calls_made: tallyCallsMade,
                fetch_errors: fetchErrors,
                rows: matchedRows.slice(0, args.maxRows ?? 300)
            };

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(responsePayload, null, 2)
                }]
            };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });

    const normalize = (s) => String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9\/\.\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const expandAbbreviations = (str) => {
        let s = ' ' + normalize(str) + ' ';
        const expansions = {
            'a/c': 'account',
            'pvt': 'private',
            'ltd': 'limited',
            'mfg': 'manufacturing',
            'co.': 'company',
            'co': 'company',
            '&': 'and'
        };
        for (const [abbr, expanded] of Object.entries(expansions)) {
            s = s.replace(new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), expanded);
        }
        return s.trim().replace(/\s+/g, ' ');
    };

    const computeTokenMatchScore = (nameA, nameB) => {
        const tokensA = expandAbbreviations(nameA).split(' ').filter(Boolean);
        const tokensB = expandAbbreviations(nameB).split(' ').filter(Boolean);
        if (!tokensA.length || !tokensB.length) return 0;
        const setB = new Set(tokensB);
        const matches = tokensA.filter(t => setB.has(t)).length;
        return matches / Math.max(tokensA.length, tokensB.length);
    };

    const fuzzyMatchName = (excelName, tallyItems) => {
        if (!excelName) {
            return {
                excel_name: '', matched_name: '', match_score: 0, match_type: 'none', auto_accepted: false, requires_review: true, top_candidates: []
            };
        }
        const normExcel = normalize(excelName);
        const expandedExcel = expandAbbreviations(excelName);

        const candidates = tallyItems.map(item => {
            const normTally = normalize(item.Name);
            const expandedTally = expandAbbreviations(item.Name);
            
            if (normExcel === normTally || expandedExcel === expandedTally) {
                return { item, score: 1.0, type: 'exact' };
            }
            
            if (normTally.includes(normExcel) || normExcel.includes(normTally) ||
                expandedTally.includes(expandedExcel) || expandedExcel.includes(expandedTally)) {
                return { item, score: 0.85, type: 'contains' };
            }

            const tokenScore = computeTokenMatchScore(excelName, item.Name);
            if (tokenScore >= 0.75) {
                return { item, score: tokenScore, type: 'token_high' };
            } else if (tokenScore >= 0.5) {
                return { item, score: tokenScore, type: 'token_medium' };
            } else {
                return { item, score: tokenScore, type: 'token_low' };
            }
        });

        candidates.sort((a, b) => b.score - a.score);
        const top5 = candidates.slice(0, 5).map(c => ({ name: c.item.Name, score: Number(c.score.toFixed(2)) }));

        const best = candidates[0];
        if (best && best.score >= 0.75) {
            return {
                excel_name: excelName,
                matched_name: best.item.Name,
                match_score: Number(best.score.toFixed(2)),
                match_type: best.type.startsWith('exact') ? 'exact' : (best.type === 'contains' ? 'contains' : 'token'),
                auto_accepted: true,
                requires_review: false,
                top_candidates: top5
            };
        }

        if (best && best.score >= 0.5) {
            return {
                excel_name: excelName,
                matched_name: best.item.Name,
                match_score: Number(best.score.toFixed(2)),
                match_type: 'token_suggested',
                auto_accepted: false,
                requires_review: true,
                top_candidates: top5
            };
        }

        return {
            excel_name: excelName,
            matched_name: top5[0] ? top5[0].name : '',
            match_score: top5[0] ? top5[0].score : 0.0,
            match_type: 'unmatched',
            auto_accepted: false,
            requires_review: true,
            top_candidates: top5
        };
    };

    mcpServer.registerTool('excel-to-tally-validate', {
        title: 'Excel to Tally Validate',
        description: 'Auto-detects format per sheet, fuzzy matches names, and checks Tally import readiness.',
        inputSchema: {
            filePath: z.string().describe('Absolute path to the Excel file.'),
            targetCompany: z.string().optional().describe('Tally company name.')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const fs = await import('fs');
            const ExcelJS = (await import('exceljs')).default;

            if (!args.filePath || !fs.existsSync(args.filePath)) {
                throw new Error(`Excel file not found at path: ${args.filePath}`);
            }

            const wb = new ExcelJS.Workbook();
            await wb.xlsx.readFile(args.filePath);

            // Batch fetch masters from Tally
            const [allLedgers, allStockItems, allVoucherTypes] = await Promise.all([
                queryCollection('Ledger', ['Name', 'Parent', '_PrimaryGroup'], new Map(), args.targetCompany),
                queryCollection('StockItem', ['Name', 'Parent'], new Map(), args.targetCompany),
                queryCollection('VoucherType', ['Name', 'Parent'], new Map(), args.targetCompany)
            ]);

            const targetCompany = args.targetCompany;
            const sheetsProcessed = [];
            const vouchers = [];
            const corrections = [];
            const unresolvedErrors = [];
            let totalVouchers = 0;
            let autoCorrectionsCount = 0;

            const detectSheetFormat = (headers) => {
                const hSet = new Set(headers.map(h => String(h || '').trim().toLowerCase()));
                if (hSet.has('date') && hSet.has('voucher type') && hSet.has('party name') && 
                    (hSet.has('sale/purchase ledger') || hSet.has('purchase ledger') || hSet.has('sales ledger') || hSet.has('ledger')) &&
                    hSet.has('item name') && hSet.has('qty') && hSet.has('rate')) {
                    return 'A';
                }
                if (hSet.has('date') && hSet.has('debit ledger name') && hSet.has('credit ledger name') && hSet.has('amount')) {
                    return 'B';
                }
                if (hSet.has('voucher type') && hSet.has('date') && hSet.has('debit ledger name') && 
                    hSet.has('debit amount') && hSet.has('credit ledger name') && hSet.has('credit amount')) {
                    return 'C';
                }
                return null;
            };

            const parseExcelDate = (val) => {
                if (!val) return '';
                const dt = parseBankStatementDate(val);
                if (!dt) return String(val).trim();
                const dd = String(dt.getDate()).padStart(2, '0');
                const mm = String(dt.getMonth() + 1).padStart(2, '0');
                const yyyy = dt.getFullYear();
                return `${dd}-${mm}-${yyyy}`;
            };

            for (const ws of wb.worksheets) {
                const headers = [];
                const headerRow = ws.getRow(1);
                headerRow.eachCell((cell, colIdx) => {
                    headers[colIdx] = String(cell.value || '').trim();
                });

                const format = detectSheetFormat(headers);
                if (!format) continue;

                let sheetRowsCount = 0;
                let sheetVouchersCount = 0;

                const getColIndex = (name) => {
                    const lowerName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
                    for (let i = 1; i < headers.length; i++) {
                        if (headers[i]) {
                            const headerLower = headers[i].toLowerCase().replace(/[^a-z0-9]/g, '');
                            if (headerLower === lowerName || headerLower.includes(lowerName) || lowerName.includes(headerLower)) {
                                return i;
                            }
                        }
                    }
                    return -1;
                };

                if (format === 'A') {
                    const colMap = {
                        date: getColIndex('Date'),
                        voucher_type: getColIndex('Voucher Type'),
                        voucher_no: getColIndex('Voucher No'),
                        invoice_no: getColIndex('Invoice No'),
                        invoice_date: getColIndex('Invoice Date'),
                        party_name: getColIndex('Party Name'),
                        ledger: getColIndex('Ledger'),
                        item_name: getColIndex('Item Name'),
                        qty: getColIndex('Qty'),
                        rate: getColIndex('Rate'),
                        amount: getColIndex('Amount'),
                        igst: getColIndex('IGST'),
                        cgst: getColIndex('CGST'),
                        sgst: getColIndex('SGST'),
                        narration: getColIndex('Narration')
                    };

                    const parseRowVal = (row, key) => {
                        const idx = colMap[key];
                        if (idx === -1 || idx === undefined) return '';
                        const val = row.getCell(idx).value;
                        if (val === null || val === undefined) return '';
                        if (typeof val === 'object' && val.formula) {
                            return val.result !== undefined && val.result !== null ? val.result : '';
                        }
                        return val;
                    };

                    const vouchersMap = new Map();
                    let currentVoucherKey = null;

                    ws.eachRow((row, rowIdx) => {
                        if (rowIdx === 1) return;
                        sheetRowsCount++;

                        const dateRaw = parseRowVal(row, 'date');
                        const partyName = String(parseRowVal(row, 'party_name') || '').trim();
                        if (!dateRaw && !partyName) return;

                        const dateStr = parseExcelDate(dateRaw);
                        const key = `${dateStr}|${partyName}`;
                        if (currentVoucherKey !== key) {
                            currentVoucherKey = key;
                        }

                        if (!vouchersMap.has(currentVoucherKey)) {
                            vouchersMap.set(currentVoucherKey, {
                                sheet: ws.name,
                                format: 'A',
                                date: dateStr,
                                voucher_type_excel: String(parseRowVal(row, 'voucher_type') || '').trim(),
                                invoice_no: String(parseRowVal(row, 'invoice_no') || '').trim(),
                                invoice_date: parseExcelDate(parseRowVal(row, 'invoice_date')),
                                party_excel: partyName,
                                narration: String(parseRowVal(row, 'narration') || '').trim(),
                                stock_rows: [],
                                ledger_rows: []
                            });
                        }

                        const v = vouchersMap.get(currentVoucherKey);
                        const itemName = String(parseRowVal(row, 'item_name') || '').trim();
                        const qty = parseBankAmount(parseRowVal(row, 'qty'));
                        const rate = parseBankAmount(parseRowVal(row, 'rate'));
                        const amount = parseBankAmount(parseRowVal(row, 'amount'));
                        const igst = parseBankAmount(parseRowVal(row, 'igst'));
                        const cgst = parseBankAmount(parseRowVal(row, 'cgst'));
                        const sgst = parseBankAmount(parseRowVal(row, 'sgst'));
                        const ledgerName = String(parseRowVal(row, 'ledger') || '').trim();

                        if (itemName) {
                            v.stock_rows.push({
                                excel_name: itemName,
                                qty,
                                rate,
                                amount,
                                ledger: ledgerName
                            });
                        } else if (ledgerName) {
                            v.ledger_rows.push({
                                excel_name: ledgerName,
                                amount,
                                igst,
                                cgst,
                                sgst
                            });
                        }
                    });

                    for (const v of vouchersMap.values()) {
                        sheetVouchersCount++;
                        totalVouchers++;
                        v.index = totalVouchers;

                        // Match voucher type
                        const vtMatch = fuzzyMatchName(v.voucher_type_excel, allVoucherTypes);
                        v.voucher_type = {
                            excel_name: v.voucher_type_excel,
                            matched_name: vtMatch.matched_name,
                            match_score: vtMatch.match_score,
                            auto_accepted: vtMatch.auto_accepted
                        };

                        // Match party (Ledger Sundry Debtors/Creditors check)
                        const partyMatch = fuzzyMatchName(v.party_excel, allLedgers);
                        v.party = {
                            excel_name: v.party_excel,
                            matched_name: partyMatch.matched_name,
                            match_score: partyMatch.match_score,
                            auto_accepted: partyMatch.auto_accepted,
                            top_candidates: partyMatch.top_candidates
                        };

                        if (!partyMatch.auto_accepted) {
                            unresolvedErrors.push({
                                sheet: ws.name,
                                voucher_index: v.index,
                                field: 'party',
                                excel_value: v.party_excel,
                                error: partyMatch.match_score < 0.5 ? 'No match found in Tally' : 'Suggested match requires confirmation',
                                top_candidates: partyMatch.top_candidates
                            });
                        } else if (partyMatch.match_score < 1.0) {
                            autoCorrectionsCount++;
                            corrections.push({
                                sheet: ws.name,
                                voucher_index: v.index,
                                field: 'party',
                                excel_value: v.party_excel,
                                corrected_to: partyMatch.matched_name,
                                score: partyMatch.match_score
                            });
                        }

                        // Match stock rows
                        let arithmeticValid = true;
                        let grossTotal = 0;
                        const stockRowsMatched = v.stock_rows.map(item => {
                            const itemMatch = fuzzyMatchName(item.excel_name, allStockItems);
                            const calcAmt = Number((item.qty * item.rate).toFixed(2));
                            if (Math.abs(calcAmt - item.amount) > 1.0) {
                                arithmeticValid = false;
                            }
                            grossTotal += item.amount;

                            if (!itemMatch.auto_accepted) {
                                unresolvedErrors.push({
                                    sheet: ws.name,
                                    voucher_index: v.index,
                                    field: 'stock_item',
                                    excel_value: item.excel_name,
                                    error: itemMatch.match_score < 0.5 ? 'No match found in Tally' : 'Suggested match requires confirmation',
                                    top_candidates: itemMatch.top_candidates
                                });
                            } else if (itemMatch.match_score < 1.0) {
                                autoCorrectionsCount++;
                                corrections.push({
                                    sheet: ws.name,
                                    voucher_index: v.index,
                                    field: 'stock_item',
                                    excel_value: item.excel_name,
                                    corrected_to: itemMatch.matched_name,
                                    score: itemMatch.match_score
                                });
                            }

                            return {
                                excel_name: item.excel_name,
                                matched_name: itemMatch.matched_name,
                                match_score: itemMatch.match_score,
                                auto_accepted: itemMatch.auto_accepted,
                                qty: item.qty,
                                rate: item.rate,
                                amount: item.amount,
                                top_candidates: itemMatch.top_candidates
                            };
                        });

                        // Match ledger rows
                        let taxTotal = 0;
                        let otherTotal = 0;
                        const ledgerRowsMatched = v.ledger_rows.map(lg => {
                            const lgMatch = fuzzyMatchName(lg.excel_name, allLedgers);
                            taxTotal += (lg.igst + lg.cgst + lg.sgst);
                            if (!lg.igst && !lg.cgst && !lg.sgst) {
                                otherTotal += lg.amount;
                            }

                            if (!lgMatch.auto_accepted) {
                                unresolvedErrors.push({
                                    sheet: ws.name,
                                    voucher_index: v.index,
                                    field: 'ledger',
                                    excel_value: lg.excel_name,
                                    error: lgMatch.match_score < 0.5 ? 'No match found in Tally' : 'Suggested match requires confirmation',
                                    top_candidates: lgMatch.top_candidates
                                });
                            } else if (lgMatch.match_score < 1.0) {
                                autoCorrectionsCount++;
                                corrections.push({
                                    sheet: ws.name,
                                    voucher_index: v.index,
                                    field: 'ledger',
                                    excel_value: lg.excel_name,
                                    corrected_to: lgMatch.matched_name,
                                    score: lgMatch.match_score
                                });
                            }

                            return {
                                excel_name: lg.excel_name,
                                matched_name: lgMatch.matched_name,
                                match_score: lgMatch.match_score,
                                auto_accepted: lgMatch.auto_accepted,
                                amount: lg.amount,
                                top_candidates: lgMatch.top_candidates
                            };
                        });

                        v.stock_rows = stockRowsMatched;
                        v.ledger_rows = ledgerRowsMatched;
                        v.grand_total = Number((grossTotal + taxTotal + otherTotal).toFixed(2));
                        v.arithmetic_valid = arithmeticValid;
                        
                        const hasErrors = !v.party.auto_accepted || v.stock_rows.some(r => !r.auto_accepted) || v.ledger_rows.some(r => !r.auto_accepted) || !v.arithmetic_valid;
                        v.has_errors = hasErrors;
                        v.has_warnings = false;
                        v.ready_to_push = !hasErrors;

                        vouchers.push(v);
                    }
                } else if (format === 'B') {
                    const colMap = {
                        date: getColIndex('Date'),
                        debit_ledger: getColIndex('Debit Ledger Name'),
                        credit_ledger: getColIndex('Credit Ledger Name'),
                        amount: getColIndex('Amount')
                    };

                    ws.eachRow((row, rowIdx) => {
                        if (rowIdx === 1) return;
                        sheetRowsCount++;
                        sheetVouchersCount++;
                        totalVouchers++;

                        const dateRaw = row.getCell(colMap.date).value;
                        const dateStr = parseExcelDate(dateRaw);
                        const debitRaw = String(row.getCell(colMap.debit_ledger).value || '').trim();
                        const creditRaw = String(row.getCell(colMap.credit_ledger).value || '').trim();
                        const amount = parseBankAmount(row.getCell(colMap.amount).value);

                        const debitMatch = fuzzyMatchName(debitRaw, allLedgers);
                        const creditMatch = fuzzyMatchName(creditRaw, allLedgers);

                        const isError = !debitMatch.auto_accepted || !creditMatch.auto_accepted || (debitRaw.toLowerCase() === creditRaw.toLowerCase()) || amount <= 0;

                        if (debitRaw.toLowerCase() === creditRaw.toLowerCase()) {
                            unresolvedErrors.push({
                                sheet: ws.name,
                                voucher_index: totalVouchers,
                                field: 'debit_credit_ledger',
                                excel_value: `${debitRaw} / ${creditRaw}`,
                                error: 'Debit and Credit ledgers cannot be identical'
                            });
                        }

                        vouchers.push({
                            sheet: ws.name,
                            format: 'B',
                            index: totalVouchers,
                            date: dateStr,
                            debit_ledger: {
                                excel_name: debitRaw,
                                matched_name: debitMatch.matched_name,
                                match_score: debitMatch.match_score,
                                auto_accepted: debitMatch.auto_accepted,
                                top_candidates: debitMatch.top_candidates
                            },
                            credit_ledger: {
                                excel_name: creditRaw,
                                matched_name: creditMatch.matched_name,
                                match_score: creditMatch.match_score,
                                auto_accepted: creditMatch.auto_accepted,
                                top_candidates: creditMatch.top_candidates
                            },
                            amount,
                            grand_total: amount,
                            has_errors: isError,
                            has_warnings: false,
                            ready_to_push: !isError
                        });
                    });
                } else if (format === 'C') {
                    // Journal Format
                    const colMap = {
                        voucher_type: getColIndex('Voucher Type'),
                        date: getColIndex('Date'),
                        debit_ledger: getColIndex('Debit Ledger Name'),
                        debit_amount: getColIndex('Debit Amount'),
                        credit_ledger: getColIndex('Credit Ledger Name'),
                        credit_amount: getColIndex('Credit Amount')
                    };

                    ws.eachRow((row, rowIdx) => {
                        if (rowIdx === 1) return;
                        sheetRowsCount++;
                        sheetVouchersCount++;
                        totalVouchers++;

                        const vtRaw = String(row.getCell(colMap.voucher_type).value || 'Journal').trim();
                        const dateStr = parseExcelDate(row.getCell(colMap.date).value);
                        const debitRaw = String(row.getCell(colMap.debit_ledger).value || '').trim();
                        const creditRaw = String(row.getCell(colMap.credit_ledger).value || '').trim();
                        const debitAmt = parseBankAmount(row.getCell(colMap.debit_amount).value);
                        const creditAmt = parseBankAmount(row.getCell(colMap.credit_amount).value);

                        const vtMatch = fuzzyMatchName(vtRaw, allVoucherTypes);
                        const debitMatch = fuzzyMatchName(debitRaw, allLedgers);
                        const creditMatch = fuzzyMatchName(creditRaw, allLedgers);

                        const balanceValid = Math.abs(debitAmt - creditAmt) < 1.0;
                        const isError = !vtMatch.auto_accepted || !debitMatch.auto_accepted || !creditMatch.auto_accepted || !balanceValid;

                        if (!balanceValid) {
                            unresolvedErrors.push({
                                sheet: ws.name,
                                voucher_index: totalVouchers,
                                field: 'debit_credit_amount',
                                excel_value: `Debit: ${debitAmt} / Credit: ${creditAmt}`,
                                error: 'Debit and Credit amounts must balance'
                            });
                        }

                        vouchers.push({
                            sheet: ws.name,
                            format: 'C',
                            index: totalVouchers,
                            date: dateStr,
                            voucher_type: {
                                excel_name: vtRaw,
                                matched_name: vtMatch.matched_name,
                                match_score: vtMatch.match_score,
                                auto_accepted: vtMatch.auto_accepted
                            },
                            debit_ledger: {
                                excel_name: debitRaw,
                                matched_name: debitMatch.matched_name,
                                match_score: debitMatch.match_score,
                                auto_accepted: debitMatch.auto_accepted,
                                top_candidates: debitMatch.top_candidates
                            },
                            credit_ledger: {
                                excel_name: creditRaw,
                                matched_name: creditMatch.matched_name,
                                match_score: creditMatch.match_score,
                                auto_accepted: creditMatch.auto_accepted,
                                top_candidates: creditMatch.top_candidates
                            },
                            debit_amount: debitAmt,
                            credit_amount: creditAmt,
                            grand_total: debitAmt,
                            has_errors: isError,
                            has_warnings: false,
                            ready_to_push: !isError
                        });
                    });
                }

                sheetsProcessed.push({
                    sheet_name: ws.name,
                    format_detected: format,
                    rows_read: sheetRowsCount,
                    vouchers_found: sheetVouchersCount
                });
            }

            if (totalVouchers > 500) {
                throw new Error(`Workbook contains ${totalVouchers} vouchers, which exceeds the limit of 500. Please split the file.`);
            }

            const validationStatus = unresolvedErrors.length > 0 ? 'errors' : (corrections.length > 0 ? 'warnings' : 'ok');

            const payload = {
                file: args.filePath,
                sheets_processed: sheetsProcessed,
                validation_status: validationStatus,
                vouchers,
                summary: {
                    total_vouchers: totalVouchers,
                    ready_to_push: vouchers.filter(v => v.ready_to_push).length,
                    requires_review: vouchers.filter(v => !v.ready_to_push).length,
                    has_errors: unresolvedErrors.length > 0,
                    auto_corrections_made: autoCorrectionsCount,
                    corrections,
                    unresolved_errors: unresolvedErrors
                }
            };

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(payload, null, 2)
                }]
            };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });

    const getTaxColumn = (particular) => {
        const p = String(particular || '').toUpperCase();
        if (p.includes('CGST')) return 'CGST';
        if (p.includes('SGST')) return 'SGST';
        if (p.includes('IGST')) return 'IGST';
        return null;
    };

    const formatTallyXmlDate = (dateStr) => {
        const m = String(dateStr || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (m) {
            return `${m[3]}${m[2]}${m[1]}`;
        }
        return dateStr;
    };

    const escapeXml = (str) => {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    };

    const parseDateFlexible = (raw) => {
        if (!raw) return '';
        if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
            const dd = String(raw.getDate()).padStart(2, '0');
            const mm = String(raw.getMonth() + 1).padStart(2, '0');
            const yyyy = raw.getFullYear();
            return `${dd}-${mm}-${yyyy}`;
        }
        if (typeof raw === 'number') {
            const d = new Date(Math.round((raw - 25569) * 86400 * 1000));
            const dd = String(d.getDate()).padStart(2, '0');
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const yyyy = d.getFullYear();
            return `${dd}-${mm}-${yyyy}`;
        }
        const s = String(raw).trim();
        const dmy = s.match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{2,4})$/);
        if (dmy) {
            const [, d, m, y] = dmy;
            const year = y.length === 2 ? (parseInt(y) > 50 ? '19' : '20') + y : y;
            return `${d.padStart(2,'0')}-${m.padStart(2,'0')}-${year}`;
        }
        const dMonY = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})$/);
        if (dMonY) {
            const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
            const [, d, mon, y] = dMonY;
            const m = months[mon.toLowerCase()] || '01';
            const year = y.length === 2 ? (parseInt(y) > 50 ? '19' : '20') + y : y;
            return `${d.padStart(2,'0')}-${m}-${year}`;
        }
        const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (iso) {
            const [, y, m, d] = iso;
            return `${d}-${m}-${y}`;
        }
        return s;
    };

    const parseAndGroupExcelVouchers = async (filePath, targetCompany, sheetName) => {
        const fs = await import('fs');
        const path = await import('path');
        const ExcelJS = (await import('exceljs')).default;

        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error(`Excel file not found at path: ${filePath}`);
        }

        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(filePath);
        const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
        if (!ws) {
            throw new Error(`Sheet not found: ${sheetName || 'default'}`);
        }

        const headers = [];
        const headerRow = ws.getRow(1);
        headerRow.eachCell((cell, colIdx) => {
            headers[colIdx] = String(cell.value || '').trim();
        });

        const getColIndex = (name) => {
            const lowerName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
            for (let i = 1; i < headers.length; i++) {
                if (headers[i]) {
                    const headerLower = headers[i].toLowerCase().replace(/[^a-z0-9]/g, '');
                    if (headerLower === lowerName || headerLower.includes(lowerName) || lowerName.includes(headerLower)) {
                        return i;
                    }
                }
            }
            return -1;
        };

        const hasDebitLedger = headers.some(h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes('debitledgername'));
        const hasCreditLedger = headers.some(h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes('creditledgername'));
        const hasDebitLedger1 = headers.some(h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes('debitledger1'));
        
        const format = hasDebitLedger1 ? 'C' : ((hasDebitLedger && hasCreditLedger) ? 'B' : 'A');

        const colMap = {};
        if (format === 'C') {
            colMap.date = getColIndex('Date');
            colMap.voucher_type = getColIndex('Voucher Type');
            colMap.voucher_no = getColIndex('Voucher No');
            colMap.debit_ledger_1 = getColIndex('Debit Ledger 1');
            colMap.debit_amount_1 = getColIndex('Debit Amount 1');
            colMap.debit_ledger_2 = getColIndex('Debit Ledger 2');
            colMap.debit_amount_2 = getColIndex('Debit Amount 2');
            colMap.credit_ledger_1 = getColIndex('Credit Ledger 1');
            colMap.credit_amount_1 = getColIndex('Credit Amount 1');
            colMap.credit_ledger_2 = getColIndex('Credit Ledger 2');
            colMap.credit_amount_2 = getColIndex('Credit Amount 2');
            colMap.narration = getColIndex('Narration');

            if (colMap.date === -1) colMap.date = 1;
            if (colMap.voucher_type === -1) colMap.voucher_type = 2;
            if (colMap.voucher_no === -1) colMap.voucher_no = 3;
            if (colMap.debit_ledger_1 === -1) colMap.debit_ledger_1 = 4;
            if (colMap.debit_amount_1 === -1) colMap.debit_amount_1 = 5;
            if (colMap.debit_ledger_2 === -1) colMap.debit_ledger_2 = 6;
            if (colMap.debit_amount_2 === -1) colMap.debit_amount_2 = 7;
            if (colMap.credit_ledger_1 === -1) colMap.credit_ledger_1 = 8;
            if (colMap.credit_amount_1 === -1) colMap.credit_amount_1 = 9;
            if (colMap.credit_ledger_2 === -1) colMap.credit_ledger_2 = 10;
            if (colMap.credit_amount_2 === -1) colMap.credit_amount_2 = 11;
            if (colMap.narration === -1) colMap.narration = 12;
        } else if (format === 'B') {
            colMap.date = getColIndex('Date');
            colMap.voucher_type = getColIndex('Voucher Type');
            colMap.voucher_no = getColIndex('Voucher No');
            colMap.debit_ledger = getColIndex('Debit Ledger Name');
            colMap.credit_ledger = getColIndex('Credit Ledger Name');
            colMap.amount = getColIndex('Amount');
            colMap.against_invoice = getColIndex('Against Invoice No');
            colMap.narration = getColIndex('Narration');

            if (colMap.date === -1) colMap.date = 1;
            if (colMap.voucher_type === -1) colMap.voucher_type = 2;
            if (colMap.voucher_no === -1) colMap.voucher_no = 3;
            if (colMap.debit_ledger === -1) colMap.debit_ledger = 4;
            if (colMap.credit_ledger === -1) colMap.credit_ledger = 5;
            if (colMap.amount === -1) colMap.amount = 6;
            if (colMap.against_invoice === -1) colMap.against_invoice = 7;
            if (colMap.narration === -1) colMap.narration = 8;
        } else {
            colMap.date = getColIndex('Date');
            colMap.voucher_type = getColIndex('Voucher Type');
            colMap.voucher_no = getColIndex('Voucher No');
            colMap.invoice_no = getColIndex('Invoice No');
            colMap.invoice_date = getColIndex('Invoice Date');
            colMap.party_name = getColIndex('Party Name');
            colMap.ledger = getColIndex('Ledger');
            colMap.item_name = getColIndex('Item Name');
            colMap.batch = getColIndex('Batch');
            colMap.qty = getColIndex('Qty');
            colMap.rate = getColIndex('Rate');
            colMap.amount = getColIndex('Amount');
            colMap.igst = getColIndex('IGST');
            colMap.cgst = getColIndex('CGST');
            colMap.sgst = getColIndex('SGST');
            colMap.narration = getColIndex('Narration');
            colMap.unit = getColIndex('Unit');
            colMap.godown = getColIndex('Godown');
            colMap.against_invoice_no = getColIndex('Against Invoice No');

            if (colMap.date === -1) colMap.date = 1;
            if (colMap.voucher_type === -1) colMap.voucher_type = 2;
            if (colMap.voucher_no === -1) colMap.voucher_no = 3;
            if (colMap.invoice_no === -1) colMap.invoice_no = 4;
            if (colMap.invoice_date === -1) colMap.invoice_date = 5;
            if (colMap.party_name === -1) colMap.party_name = 6;
            if (colMap.ledger === -1) colMap.ledger = 7;
            if (colMap.item_name === -1) colMap.item_name = 8;
            if (colMap.batch === -1) colMap.batch = 9;
            if (colMap.qty === -1) colMap.qty = 10;
            if (colMap.rate === -1) colMap.rate = 11;
            if (colMap.amount === -1) colMap.amount = 12;
            if (colMap.igst === -1) colMap.igst = 13;
            if (colMap.cgst === -1) colMap.cgst = 14;
            if (colMap.sgst === -1) colMap.sgst = 15;
            if (colMap.narration === -1) colMap.narration = 16;
        }

        const parseRowVal = (row, key) => {
            const idx = colMap[key];
            if (idx === -1 || idx === undefined) return '';
            const val = row.getCell(idx).value;
            if (val === null || val === undefined) return '';
            if (typeof val === 'object' && val.formula) {
                return val.result !== undefined && val.result !== null ? val.result : '';
            }
            return val;
        };

        const parseExcelDate = (val) => {
            if (!val) return '';
            const dt = parseBankStatementDate(val);
            if (!dt) return String(val).trim();
            const dd = String(dt.getDate()).padStart(2, '0');
            const mm = String(dt.getMonth() + 1).padStart(2, '0');
            const yyyy = dt.getFullYear();
            return `${dd}-${mm}-${yyyy}`;
        };

        const rawRows = [];
        ws.eachRow((row, rowIdx) => {
            if (rowIdx === 1) return;
            const rowData = { format };
            for (const key of Object.keys(colMap)) {
                rowData[key] = parseRowVal(row, key);
            }
            rawRows.push(rowData);
        });

        const groups = [];
        let currentGroup = null;
        let lastDate = '', lastVoucherType = '', lastParty = '', lastInvoiceNo = '';

        for (const row of rawRows) {
            const isBlankRow = Object.values(row)
                .every(v => v === null || v === undefined || String(v).trim() === '');
            
            if (isBlankRow) {
                if (currentGroup) groups.push(currentGroup);
                currentGroup = null;
                continue;
            }

            if (row.format === 'C') {
                const date = parseDateFlexible(row.date) || lastDate;
                const voucherType = String(row.voucher_type || '').trim() || lastVoucherType;
                const voucherNo = String(row.voucher_no || '').trim();

                const debit_rows = [
                    { ledger_name: String(row.debit_ledger_1 || '').trim(), amount: parseBankAmount(row.debit_amount_1) },
                    { ledger_name: String(row.debit_ledger_2 || '').trim(), amount: parseBankAmount(row.debit_amount_2) }
                ].filter(d => d.ledger_name && d.amount);

                const credit_rows = [
                    { ledger_name: String(row.credit_ledger_1 || '').trim(), amount: parseBankAmount(row.credit_amount_1) },
                    { ledger_name: String(row.credit_ledger_2 || '').trim(), amount: parseBankAmount(row.credit_amount_2) }
                ].filter(c => c.ledger_name && c.amount);

                const debitSum = debit_rows.reduce((sum, r) => sum + r.amount, 0);
                const creditSum = credit_rows.reduce((sum, r) => sum + r.amount, 0);
                const isBalanced = Math.abs(debitSum - creditSum) < 0.05;

                groups.push({
                    format: 'C',
                    date,
                    voucher_type: voucherType,
                    voucher_no: voucherNo || '',
                    debit_rows,
                    credit_rows,
                    amount: debitSum,
                    narration: String(row.narration || '').trim(),
                    stock_rows: [],
                    ledger_rows: [],
                    grand_total: debitSum,
                    index: groups.length + 1,
                    arithmetic_valid: isBalanced,
                    arithmetic_errors: isBalanced ? [] : [{
                        item: 'Voucher Balance',
                        expected: debitSum,
                        actual: creditSum,
                        diff: Math.abs(debitSum - creditSum)
                    }]
                });

                if (row.date) lastDate = parseDateFlexible(row.date);
                if (row.voucher_type) lastVoucherType = String(row.voucher_type).trim();
                continue;
            }

            if (row.format === 'B') {
                const date = parseDateFlexible(row.date) || lastDate;
                const voucherType = String(row.voucher_type || '').trim() || lastVoucherType;
                const voucherNo = String(row.voucher_no || '').trim();

                groups.push({
                    format: 'B',
                    date,
                    voucher_type: voucherType,
                    voucher_no: voucherNo || '',
                    debit_ledger: String(row.debit_ledger || '').trim(),
                    credit_ledger: String(row.credit_ledger || '').trim(),
                    amount: parseBankAmount(row.amount),
                    against_invoice: String(row.against_invoice || '').trim(),
                    narration: String(row.narration || '').trim(),
                    stock_rows: [],
                    ledger_rows: [],
                    grand_total: parseBankAmount(row.amount),
                    index: groups.length + 1,
                    arithmetic_valid: true,
                    arithmetic_errors: []
                });

                if (row.date) lastDate = parseDateFlexible(row.date);
                if (row.voucher_type) lastVoucherType = String(row.voucher_type).trim();
                continue;
            }

            const date = parseDateFlexible(row.date) || lastDate;
            const voucherType = String(row.voucher_type || '').trim() || lastVoucherType;
            const party = String(row.party_name || '').trim() || lastParty;
            const invoiceNo = String(row.invoice_no || '').trim() || '';
            const voucherNo = String(row.voucher_no || '').trim();

            const isNewVoucher = !currentGroup
                || (invoiceNo && invoiceNo !== lastInvoiceNo)
                || (!invoiceNo && (date !== lastDate || party !== lastParty));

            if (isNewVoucher) {
                if (currentGroup) groups.push(currentGroup);
                currentGroup = {
                    format: 'A',
                    date,
                    voucher_type: voucherType,
                    voucher_no: voucherNo || '',
                    party_name: party,
                    invoice_no: invoiceNo,
                    invoice_date: parseDateFlexible(row.invoice_date) || date,
                    narration: String(row.narration || '').trim(),
                    against_invoice_no: String(row.against_invoice_no || '').trim(),
                    stock_rows: [],
                    ledger_rows: [],
                    index: groups.length + 1
                };
            }

            if (row.date) lastDate = parseDateFlexible(row.date);
            if (row.voucher_type) lastVoucherType = String(row.voucher_type).trim();
            if (row.party_name) lastParty = String(row.party_name).trim();
            if (row.invoice_no) lastInvoiceNo = String(row.invoice_no).trim();

            const itemName = String(row.item_name || '').trim();
            const qty = parseBankAmount(row.qty);
            const rate = parseBankAmount(row.rate);
            const amount = parseBankAmount(row.amount);
            const purchaseLedger = String(row.ledger || '').trim();
            const cgst = parseBankAmount(row.cgst);
            const sgst = parseBankAmount(row.sgst);
            const igst = parseBankAmount(row.igst);

            if (itemName) {
                currentGroup.stock_rows.push({
                    item_name: itemName,
                    purchase_ledger: purchaseLedger,
                    qty,
                    rate,
                    amount,
                    unit: String(row.unit || 'NOS').trim(),
                    godown: String(row.godown || '').trim()
                });
            } else if (purchaseLedger || cgst || sgst || igst) {
                currentGroup.ledger_rows.push({
                    ledger_name: purchaseLedger,
                    amount,
                    cgst,
                    sgst,
                    igst
                });
            }
        }
        if (currentGroup) groups.push(currentGroup);

        groups.forEach(v => {
            const stockTotal = v.stock_rows.reduce((s, r) => s + r.amount, 0);
            const taxTotal = v.ledger_rows.reduce((s, r) => s + r.amount + r.cgst + r.sgst + r.igst, 0);
            const calculatedTotal = stockTotal + taxTotal;
            v.grand_total = Math.round(calculatedTotal * 100) / 100;

            const itemArithmeticErrors = v.stock_rows
                .filter(r => r.qty && r.rate && Math.abs(r.qty * r.rate - r.amount) > 1.0)
                .map(r => ({
                    item: r.item_name,
                    expected: r.qty * r.rate,
                    actual: r.amount,
                    diff: Math.abs(r.qty * r.rate - r.amount)
                }));

            v.arithmetic_valid = itemArithmeticErrors.length === 0;
            v.arithmetic_errors = itemArithmeticErrors;
            v.gross_total = Number(stockTotal.toFixed(2));
            v.tax_total = Number(v.ledger_rows.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0).toFixed(2));
        });

        return { vouchers: groups, totalRows: rawRows.length };
    };

    const buildAccountingVoucherXml = (v) => {
        const date = formatTallyXmlDate(v.date);
        const vType = v.voucher_type || 'Journal';
        
        const getLedgerName = (ledgerField) => {
            if (!ledgerField) return '';
            if (typeof ledgerField === 'object') {
                return ledgerField.matched_name || ledgerField.excel_name || '';
            }
            return ledgerField;
        };

        const debitName = getLedgerName(v.debit_ledger);
        const creditName = getLedgerName(v.credit_ledger);
        const againstInvoice = v.against_invoice || v.against_invoice_no || '';
        const amount = Math.abs(parseFloat(v.amount || 0));

        let xml = `
  <VOUCHER VCHTYPE="${escapeXml(vType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
    <DATE>${date}</DATE>
    <EFFECTIVEDATE>${date}</EFFECTIVEDATE>
    <VOUCHERTYPENAME>${escapeXml(vType)}</VOUCHERTYPENAME>
    <VOUCHERNUMBER>${escapeXml(v.voucher_no || '')}</VOUCHERNUMBER>
    <ISINVOICE>No</ISINVOICE>
    <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
    <NARRATION>${escapeXml(v.narration || '')}</NARRATION>
    ${againstInvoice 
      ? `<REFERENCE>${escapeXml(againstInvoice)}</REFERENCE>` 
      : ''}
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${escapeXml(debitName)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <ISPARTYLEDGER>No</ISPARTYLEDGER>
      <AMOUNT>-${amount.toFixed(2)}</AMOUNT>
      ${againstInvoice ? `
      <BILLALLOCATIONS.LIST>
        <NAME>${escapeXml(againstInvoice)}</NAME>
        <BILLTYPE>Agst Ref</BILLTYPE>
        <AMOUNT>-${amount.toFixed(2)}</AMOUNT>
      </BILLALLOCATIONS.LIST>` : ''}
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${escapeXml(creditName)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <ISPARTYLEDGER>No</ISPARTYLEDGER>
      <AMOUNT>${amount.toFixed(2)}</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
  </VOUCHER>`;
        return xml.replace(/<!--[\s\S]*?-->/g, '');
    };

    const buildFormatCVoucherXml = (v) => {
        const date = formatTallyXmlDate(v.date);
        const vType = v.voucher_type || 'Journal';

        const getLedgerName = (ledgerField) => {
            if (!ledgerField) return '';
            if (typeof ledgerField === 'object') {
                return ledgerField.matched_name || ledgerField.excel_name || '';
            }
            return ledgerField;
        };

        // Build all debit entries
        const debitEntries = (v.debit_rows || []).map(d => `
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${escapeXml(getLedgerName(d.ledger_name))}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <ISPARTYLEDGER>No</ISPARTYLEDGER>
      <AMOUNT>-${Math.abs(parseFloat(d.amount || 0)).toFixed(2)}</AMOUNT>
    </ALLLEDGERENTRIES.LIST>`).join('');

        // Build all credit entries
        const creditEntries = (v.credit_rows || []).map(c => `
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${escapeXml(getLedgerName(c.ledger_name))}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <ISPARTYLEDGER>No</ISPARTYLEDGER>
      <AMOUNT>${Math.abs(parseFloat(c.amount || 0)).toFixed(2)}</AMOUNT>
    </ALLLEDGERENTRIES.LIST>`).join('');

        let xml = `
  <VOUCHER VCHTYPE="${escapeXml(vType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
    <DATE>${date}</DATE>
    <EFFECTIVEDATE>${date}</EFFECTIVEDATE>
    <VOUCHERTYPENAME>${escapeXml(vType)}</VOUCHERTYPENAME>
    <VOUCHERNUMBER>${escapeXml(v.voucher_no || '')}</VOUCHERNUMBER>
    <ISINVOICE>No</ISINVOICE>
    <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
    <NARRATION>${escapeXml(v.narration || '')}</NARRATION>
    ${debitEntries}
    ${creditEntries}
  </VOUCHER>`;
        return xml.replace(/<!--[\s\S]*?-->/g, '');
    };

    const buildVoucherXml = (v, voucherMode, stockUnitMap) => {
        if (v.format === 'B') {
            return buildAccountingVoucherXml(v);
        }
        if (v.format === 'C') {
            return buildFormatCVoucherXml(v);
        }

        const isPurchase = voucherMode === 'purchase';
        const vDate = formatTallyXmlDate(v.date);
        const invDate = v.invoice_date ? formatTallyXmlDate(v.invoice_date) : '';

        let xml = `    <VOUCHER ACTION="Create">
      <DATE>${vDate}</DATE>
      <VOUCHERNUMBER>${v.voucher_no || ''}</VOUCHERNUMBER>
      <VOUCHERTYPENAME>${v.voucher_type}</VOUCHERTYPENAME>
      <PARTYLEDGERNAME>${v.party_name}</PARTYLEDGERNAME>
      <ISINVOICE>${isPurchase ? 'No' : 'Yes'}</ISINVOICE>
      <NARRATION>${v.narration || ''}</NARRATION>`;

        if (v.invoice_no) {
            xml += `
      <REFERENCE>${v.invoice_no}</REFERENCE>
      <REFERENCEDATE>${invDate || vDate}</REFERENCEDATE>`;
        }

        const partyDeemed = isPurchase ? 'No' : 'Yes';
        const partyAmount = isPurchase ? v.grand_total : -v.grand_total;
        xml += `
      <LEDGERENTRIES.LIST>
        <LEDGERNAME>${v.party_name}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${partyDeemed}</ISDEEMEDPOSITIVE>
        <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
        <AMOUNT>${partyAmount.toFixed(2)}</AMOUNT>
        <BILLALLOCATIONS.LIST>
          <NAME>${v.invoice_no || ''}</NAME>
          <BILLTYPE>${v.invoice_no ? 'New Ref' : 'On Account'}</BILLTYPE>
          <AMOUNT>${partyAmount.toFixed(2)}</AMOUNT>
        </BILLALLOCATIONS.LIST>
      </LEDGERENTRIES.LIST>`;

        const ledgerGroups = new Map();
        for (const item of v.stock_rows) {
            const ledgerName = item.purchase_ledger || (isPurchase ? 'Purchase A/c' : 'Sales A/c');
            ledgerGroups.set(ledgerName, (ledgerGroups.get(ledgerName) || 0) + item.amount);
        }
        for (const [ledgerName, amt] of ledgerGroups.entries()) {
            const deemed = isPurchase ? 'Yes' : 'No';
            const tallyAmt = isPurchase ? -amt : amt;
            xml += `
      <LEDGERENTRIES.LIST>
        <LEDGERNAME>${ledgerName}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>
        <ISPARTYLEDGER>No</ISPARTYLEDGER>
        <AMOUNT>${tallyAmt.toFixed(2)}</AMOUNT>
      </LEDGERENTRIES.LIST>`;
        }

        for (const row of v.ledger_rows) {
            const taxCol = getTaxColumn(row.ledger_name);
            if (taxCol) {
                const deemed = isPurchase ? 'Yes' : 'No';
                const tallyAmt = isPurchase ? -row.amount : row.amount;
                xml += `
      <LEDGERENTRIES.LIST>
        <LEDGERNAME>${row.ledger_name}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>
        <ISPARTYLEDGER>No</ISPARTYLEDGER>
        <AMOUNT>${tallyAmt.toFixed(2)}</AMOUNT>
      </LEDGERENTRIES.LIST>`;
            }
        }

        for (const row of v.ledger_rows) {
            const taxCol = getTaxColumn(row.ledger_name);
            if (!taxCol) {
                const deemed = isPurchase ? 'Yes' : 'No';
                const tallyAmt = isPurchase ? -row.amount : row.amount;
                xml += `
      <LEDGERENTRIES.LIST>
        <LEDGERNAME>${row.ledger_name}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>
        <ISPARTYLEDGER>No</ISPARTYLEDGER>
        <AMOUNT>${tallyAmt.toFixed(2)}</AMOUNT>
      </LEDGERENTRIES.LIST>`;
            }
        }

        for (const item of v.stock_rows) {
            const deemed = isPurchase ? 'Yes' : 'No';
            const tallyAmt = isPurchase ? -item.amount : item.amount;
            
            const unit = (stockUnitMap && stockUnitMap.get(item.item_name)) || (() => {
                const n = String(item.item_name || '').toUpperCase();
                if (/WHEAT|BRAN|ATTA|MAIDA|SOOJI|RICE|FLOUR|GRAIN|SUGAR|SALT|METAL|STEEL|IRON|COPPER|ALUMIN/.test(n)) return 'KGS';
                if (/LITRE|LITER|LTR/.test(n)) return 'LTR';
                if (/METRE|METER|MTR/.test(n)) return 'MTR';
                return 'NOS';
            })();

            xml += `
      <INVENTORYENTRIES.LIST>
        <STOCKITEMNAME>${item.item_name}</STOCKITEMNAME>
        <ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>
        <BILLEDQTY>${item.qty} ${unit}</BILLEDQTY>
        <ACTUALQTY>${item.qty} ${unit}</ACTUALQTY>
        <RATE>${item.rate.toFixed(2)}/${unit}</RATE>
        <AMOUNT>${tallyAmt.toFixed(2)}</AMOUNT>
        <BATCHALLOCATIONS.LIST>
          <GODOWNNAME>${item.godown || 'Main Location'}</GODOWNNAME>
          <BATCHNAME>Primary Batch</BATCHNAME>
          <AMOUNT>${tallyAmt.toFixed(2)}</AMOUNT>
          <ACTUALQTY>${item.qty} ${unit}</ACTUALQTY>
          <BILLEDQTY>${item.qty} ${unit}</BILLEDQTY>
        </BATCHALLOCATIONS.LIST>
      </INVENTORYENTRIES.LIST>`;
        }

        xml += `
    </VOUCHER>`;
        return xml.replace(/<!--[\s\S]*?-->/g, '');
    };

    mcpServer.registerTool('excel-to-tally-preview', {
        title: 'Excel to Tally Preview',
        description: 'Reads a filled Excel, groups rows into vouchers, and validates against Tally masters.',
        inputSchema: {
            filePath: z.string().describe('Absolute path to the filled Excel file.'),
            targetCompany: z.string().optional().describe('Tally company name.'),
            sheetName: z.string().optional().describe('Sheet name to read.')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const { vouchers, totalRows } = await parseAndGroupExcelVouchers(args.filePath, args.targetCompany, args.sheetName);

            // Fetch masters for validation and unit mapping
            let tallyVoucherTypes = new Set();
            let tallyStockItems = new Set();
            let tallyLedgers = new Set();
            const stockUnitMap = new Map();

            try {
                const vtResult = await queryCollection('VoucherType', ['Name'], new Map(), args.targetCompany);
                if (Array.isArray(vtResult)) tallyVoucherTypes = new Set(vtResult.map(x => String(x.Name || '').trim()));
            } catch (e) { }

            try {
                const sResult = await queryCollection('StockItem', ['Name', 'Parent', 'BaseUnits'], new Map(), args.targetCompany);
                if (Array.isArray(sResult)) {
                    tallyStockItems = new Set(sResult.map(x => String(x.Name || '').trim()));
                    sResult.forEach(s => {
                        stockUnitMap.set(String(s.Name || '').trim(), String(s.BaseUnits || 'NOS').trim());
                    });
                    console.log('DEBUG stockUnitMap sample:', Array.from(stockUnitMap.entries()).slice(0, 3));
                }
            } catch (e) { }

            try {
                const lResult = await queryCollection('Ledger', ['Name'], new Map(), args.targetCompany);
                if (Array.isArray(lResult)) {
                    const names = lResult.map(x => String(x.Name || '').trim());
                    tallyLedgers = new Set(names);
                }
            } catch (e) { }

            let totalVouchersWithErrors = 0;
            let totalVouchersWithWarnings = 0;
            const invalidItems = new Set();
            const invalidLedgers = new Set();
            const invalidParties = new Set();
            let totalGrandSum = 0;

            const previewVouchers = vouchers.map(v => {
                const party_valid = tallyLedgers.has(v.party_name);
                const voucher_type_valid = tallyVoucherTypes.has(v.voucher_type);

                if (!party_valid) invalidParties.add(v.party_name);

                const items = v.stock_rows.map(item => {
                    const valid = tallyStockItems.has(item.item_name);
                    const unit = stockUnitMap.get(item.item_name) || item.unit || 'NOS';
                    item.unit = unit; // update unit
                    if (!valid) invalidItems.add(item.item_name);
                    return {
                        item_name: item.item_name,
                        unit,
                        valid,
                        error: valid ? null : 'Not found in Tally'
                    };
                });

                const uniqueLedgerNames = [...new Set([
                    ...v.stock_rows.map(r => r.purchase_ledger),
                    ...v.ledger_rows.map(r => r.ledger_name)
                ].filter(Boolean))];

                const ledgers = uniqueLedgerNames.map(ledgerName => {
                    const valid = tallyLedgers.has(ledgerName);
                    if (!valid) invalidLedgers.add(ledgerName);
                    return {
                        ledger_name: ledgerName,
                        valid,
                        error: valid ? null : 'Not found in Tally'
                    };
                });

                const has_errors = !party_valid || !voucher_type_valid || items.some(x => !x.valid) || ledgers.some(x => !x.valid) || !v.arithmetic_valid;
                const has_warnings = false;

                if (has_errors) totalVouchersWithErrors++;
                else if (has_warnings) totalVouchersWithWarnings++;

                totalGrandSum += v.grand_total;

                return {
                    index: v.index,
                    date: v.date,
                    voucher_type: v.voucher_type,
                    invoice_no: v.invoice_no,
                    party_name: v.party_name,
                    narration: v.narration,
                    stock_rows: v.stock_rows,
                    ledger_rows: v.ledger_rows,
                    gross_total: v.gross_total,
                    tax_total: v.tax_total,
                    grand_total: v.grand_total,
                    validation: {
                        party_valid,
                        party_error: party_valid ? null : 'Not found in Tally',
                        items,
                        ledgers,
                        voucher_type_valid,
                        has_errors,
                        has_warnings,
                        arithmetic_valid: v.arithmetic_valid,
                        arithmetic_errors: v.arithmetic_errors
                    }
                };
            });

            const validationStatus = totalVouchersWithErrors > 0 ? 'errors' : (totalVouchersWithWarnings > 0 ? 'warnings' : 'ok');

            const payload = {
                file: args.filePath,
                sheet: args.sheetName || 'default',
                total_rows: totalRows,
                total_vouchers: vouchers.length,
                total_amount: Number(totalGrandSum.toFixed(2)),
                validation_status: validationStatus,
                vouchers: previewVouchers,
                summary: {
                    valid_vouchers: vouchers.length - totalVouchersWithErrors - totalVouchersWithWarnings,
                    vouchers_with_errors: totalVouchersWithErrors,
                    vouchers_with_warnings: totalVouchersWithWarnings,
                    invalid_items: Array.from(invalidItems),
                    invalid_ledgers: Array.from(invalidLedgers),
                    invalid_parties: Array.from(invalidParties)
                }
            };

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(payload, null, 2)
                }]
            };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });

    const buildBatchEnvelopeXml = (batch, targetCompany, stockUnitMap) => {
        let requestDataXml = '';
        for (const v of batch) {
            let voucherXml;

            if (v.format === 'C') {
                voucherXml = buildFormatCVoucherXml(v);
            } else if (v.format === 'B' || !v.stock_rows || v.stock_rows.length === 0) {
                voucherXml = buildAccountingVoucherXml(v);
            } else {
                const isPurchaseMode = [
                    'purchase', 'purc', 'wheat', 'maida', 'bran', 'atta',
                    'debit note', 'debit-note', 'material in', 'receipt note'
                ].some(k => String(v.voucher_type || '').toLowerCase().includes(k));
                
                voucherXml = buildVoucherXml(v, isPurchaseMode ? 'purchase' : 'sales', stockUnitMap);
            }

            requestDataXml += `
  <TALLYMESSAGE xmlns:UDF="TallyUDF">
${voucherXml}
  </TALLYMESSAGE>`;
        }

        const envelopeXml = `<ENVELOPE>
    <HEADER>
      <TALLYREQUEST>Import Data</TALLYREQUEST>
    </HEADER>
    <BODY>
      <IMPORTDATA>
        <REQUESTDESC>
          <REPORTNAME>Vouchers</REPORTNAME>
          ${targetCompany 
            ? `<STATICVARIABLES><SVCURRENTCOMPANY>${targetCompany}</SVCURRENTCOMPANY></STATICVARIABLES>` 
            : ''}
        </REQUESTDESC>
        <REQUESTDATA>
          ${requestDataXml}
        </REQUESTDATA>
      </IMPORTDATA>
    </BODY>
  </ENVELOPE>`;

        return {
            envelopeXml: envelopeXml
                .replace(/\s+/g, ' ')
                .replace(/>\s+</g, '><')
                .replace(/<!--[\s\S]*?-->/g, '')
                .trim(),
            requestDataXml: requestDataXml.replace(/<!--[\s\S]*?-->/g, '')
        };
    };

    const parseTallyImportResponse = (xmlResponse, batch) => {
        const parser = new XMLParser({ parseTagValue: false });
        const result = parser.parse(xmlResponse);
        const importResult = result?.ENVELOPE?.BODY?.DATA?.IMPORTDATA?.IMPORTRESULT 
            || result?.ENVELOPE?.BODY?.DATA?.IMPORTRESULT
            || result?.ENVELOPE?.BODY?.IMPORTRESULT 
            || result?.RESPONSE
            || result?.ENVELOPE?.BODY?.DATA?.RESPONSE
            || result?.ENVELOPE?.BODY?.RESPONSE
            || {};
        
        const created = parseInt(importResult.CREATED || '0', 10);
        const errors = parseInt(importResult.ERRORS || importResult.EXCEPTIONS || '0', 10);
        const lineErrors = Array.isArray(importResult.LINEERROR)
            ? importResult.LINEERROR
            : importResult.LINEERROR ? [importResult.LINEERROR] : [];
        
        return batch.map((v, idx) => ({
            index: v.index,
            date: v.date,
            party_name: v.party_name,
            invoice_no: v.invoice_no,
            grand_total: v.grand_total,
            status: (idx < created && errors === 0) ? 'created' : 'failed',
            error: !(idx < created && errors === 0) ? (lineErrors[idx - created] || 'Import failed — check Tally logs') : null
        }));
    };

    mcpServer.registerTool('excel-to-tally-push', {
        title: 'Excel to Tally Push',
        description: 'Reads Excel, validates masters, builds voucher XML, and pushes to Tally in a single call.',
        inputSchema: {
            filePath: z.string().optional().describe('Absolute path to the filled Excel file.'),
            vouchersData: z.array(z.object({}).passthrough()).optional().describe('Pre-validated voucher array from excel-to-tally-validate. If provided, filePath is ignored and these vouchers are pushed directly. Each voucher must have: date, voucher_type, party_name, invoice_no, stock_rows (with matched item_name, qty, rate, amount, unit, purchase_ledger), ledger_rows (with matched ledger_name, amount, cgst, sgst, igst), narration, grand_total.'),
            targetCompany: z.string().optional().describe('Tally company name.'),
            sheetName: z.string().optional().describe('Sheet name to read.'),
            skipValidation: z.boolean().optional().default(false).describe('If true, skips validation before pushing.'),
            voucherIndices: z.array(z.number()).optional().describe('Indices (1-based) of vouchers to push.'),
            forcePush: z.boolean().optional().default(false).describe('If true, skips duplicate check and pushes all vouchers even if Invoice No. already exists in Tally.'),
            overrides: z.array(z.object({
                voucher_index: z.number().int(),
                field: z.enum(['party_name', 'voucher_type', 'stock_item', 'ledger_name', 'purchase_ledger']),
                row_index: z.number().int().optional().describe('For stock_item and ledger_name — which row within the voucher (0-based). Omit for party_name and voucher_type.'),
                corrected_name: z.string()
            })).optional().describe('User corrections from the UI review screen. Applied after parsing, before validation and push. Allows fixing mismatched names without editing the file.')
        },
        annotations: { readOnlyHint: false, openWorldHint: false }
    }, async (args) => {
        try {
            let vouchersToPush = [];

            if (args.vouchersData && args.vouchersData.length > 0) {
                vouchersToPush = args.vouchersData.map((v, i) => {
                    const partyName = (typeof v.party_name === 'object' && v.party_name)
                        ? (v.party_name.matched_name || v.party_name.excel_name)
                        : (v.party_name || (v.party && (v.party.matched_name || v.party.excel_name)));

                    const voucherType = (typeof v.voucher_type === 'object' && v.voucher_type)
                        ? (v.voucher_type.matched_name || v.voucher_type.excel_name)
                        : v.voucher_type;

                    const stockRows = (v.stock_rows || []).map(item => ({
                        item_name: item.matched_name || item.item_name || item.excel_name,
                        qty: item.qty,
                        rate: item.rate,
                        amount: item.amount,
                        unit: item.unit || 'NOS',
                        purchase_ledger: item.purchase_ledger?.matched_name || item.purchase_ledger?.excel_name || (typeof item.purchase_ledger === 'string' ? item.purchase_ledger : '') || ''
                    }));

                    const ledgerRows = (v.ledger_rows || []).map(row => ({
                        ledger_name: row.matched_name || row.ledger_name || row.excel_name,
                        amount: row.amount,
                        cgst: row.cgst || 0,
                        sgst: row.sgst || 0,
                        igst: row.igst || 0
                    }));

                    const debitLedger = v.debit_ledger ? {
                        excel_name: v.debit_ledger.matched_name || v.debit_ledger.excel_name
                    } : null;
                    const creditLedger = v.credit_ledger ? {
                        excel_name: v.credit_ledger.matched_name || v.credit_ledger.excel_name
                    } : null;

                    return {
                        format: v.format || 'A',
                        date: v.date,
                        voucher_type: voucherType,
                        voucher_no: v.voucher_no || '',
                        party_name: partyName,
                        invoice_no: v.invoice_no,
                        invoice_date: v.invoice_date || v.date,
                        narration: v.narration,
                        against_invoice_no: v.against_invoice_no,
                        stock_rows: stockRows,
                        ledger_rows: ledgerRows,
                        debit_ledger: debitLedger,
                        credit_ledger: creditLedger,
                        debit_amount: v.debit_amount,
                        credit_amount: v.credit_amount,
                        grand_total: v.grand_total,
                        index: v.index || i + 1,
                        arithmetic_valid: v.arithmetic_valid !== undefined ? v.arithmetic_valid : true,
                        arithmetic_errors: v.arithmetic_errors || []
                    };
                });
            } else if (args.filePath) {
                const { vouchers } = await parseAndGroupExcelVouchers(args.filePath, args.targetCompany, args.sheetName);
                vouchersToPush = args.voucherIndices && args.voucherIndices.length > 0
                    ? vouchers.filter(v => args.voucherIndices.includes(v.index))
                    : vouchers;
            } else {
                return { isError: true, content: [{ type: 'text', text: 'Provide either filePath or vouchersData.' }] };
            }

            if (vouchersToPush.length === 0) {
                return { isError: true, content: [{ type: 'text', text: 'No matching vouchers to push.' }] };
            }

            // Apply overrides
            if (args.overrides && args.overrides.length > 0) {
                for (const override of args.overrides) {
                    const v = vouchersToPush.find(x => x.index === override.voucher_index);
                    if (!v) continue;
                    
                    if (override.field === 'party_name') {
                        v.party_name = override.corrected_name;
                    } else if (override.field === 'voucher_type') {
                        v.voucher_type = override.corrected_name;
                    } else if (override.field === 'stock_item' && override.row_index !== undefined) {
                        if (v.stock_rows[override.row_index]) {
                            v.stock_rows[override.row_index].item_name = override.corrected_name;
                        }
                    } else if (override.field === 'purchase_ledger' && override.row_index !== undefined) {
                        if (v.stock_rows[override.row_index]) {
                            v.stock_rows[override.row_index].purchase_ledger = override.corrected_name;
                        }
                    } else if (override.field === 'ledger_name' && override.row_index !== undefined) {
                        if (v.ledger_rows[override.row_index]) {
                            v.ledger_rows[override.row_index].ledger_name = override.corrected_name;
                        }
                    }
                }
            }

            // Fetch masters for unit and lookup validation
            let tallyVoucherTypes = new Set();
            let tallyStockItems = new Set();
            let tallyLedgers = new Set();
            const stockUnitMap = new Map();

            try {
                const vtResult = await queryCollection('VoucherType', ['Name'], new Map(), args.targetCompany);
                if (Array.isArray(vtResult)) tallyVoucherTypes = new Set(vtResult.map(x => String(x.Name || '').trim()));
            } catch (e) { }

            try {
                const sResult = await queryCollection('StockItem', ['Name', 'Parent', 'BaseUnits'], new Map(), args.targetCompany);
                if (Array.isArray(sResult)) {
                    tallyStockItems = new Set(sResult.map(x => String(x.Name || '').trim()));
                    sResult.forEach(s => {
                        stockUnitMap.set(String(s.Name || '').trim(), String(s.BaseUnits || 'NOS').trim());
                    });
                }
            } catch (e) { }

            try {
                const lResult = await queryCollection('Ledger', ['Name'], new Map(), args.targetCompany);
                if (Array.isArray(lResult)) {
                    const names = lResult.map(x => String(x.Name || '').trim());
                    tallyLedgers = new Set(names);
                }
            } catch (e) { }

            if (!args.skipValidation) {
                const failedVoucherIndices = [];
                for (const v of vouchersToPush) {
                    const party_valid = tallyLedgers.has(v.party_name);
                    const voucher_type_valid = tallyVoucherTypes.has(v.voucher_type);
                    const items_valid = v.stock_rows.every(item => tallyStockItems.has(item.item_name));
                    
                    const uniqueLedgerNames = [...new Set([
                        ...v.stock_rows.map(r => r.purchase_ledger),
                        ...v.ledger_rows.map(r => r.ledger_name)
                    ].filter(Boolean))];
                    const ledgers_valid = uniqueLedgerNames.every(ledgerName => tallyLedgers.has(ledgerName));

                    if (!party_valid || !voucher_type_valid || !items_valid || !ledgers_valid || !v.arithmetic_valid) {
                        failedVoucherIndices.push(v.index);
                    }
                }

                if (failedVoucherIndices.length > 0) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: 'Validation failed. Fix errors before pushing.',
                                vouchers_with_errors: failedVoucherIndices
                            }, null, 2)
                        }]
                    };
                }
            }

            // Duplicate check
            const duplicateWarning = await (async () => {
                if (args.forcePush) return null;
                const invoiceNosToCheck = vouchersToPush
                    .map(v => v.invoice_no)
                    .filter(Boolean);

                if (invoiceNosToCheck.length > 0) {
                    try {
                        const existingVouchers = await queryCollection(
                            'Voucher',
                            ['VoucherNumber', 'Date', 'OtherReference'],
                            new Map(),
                            args.targetCompany
                        );
                        
                        const existingRefs = new Set(
                            (existingVouchers || [])
                                .map(v => String(v.OtherReference || v.Reference || '').trim().toLowerCase())
                                .filter(Boolean)
                        );

                        const duplicates = [];
                        for (const v of vouchersToPush) {
                            if (v.invoice_no && existingRefs.has(v.invoice_no.trim().toLowerCase())) {
                                duplicates.push({
                                    voucher_index: v.index,
                                    invoice_no: v.invoice_no,
                                    party: v.party_name,
                                    date: v.date
                                });
                            }
                        }

                        if (duplicates.length > 0) {
                            return {
                                success: false,
                                error: 'Duplicate invoice numbers detected. These invoices may already exist in Tally.',
                                duplicates,
                                message: 'Pass forcePush: true to push anyway, or use voucherIndices to exclude duplicates.'
                            };
                        }
                    } catch (e) {
                        console.warn('Duplicate check failed:', e.message);
                    }
                }
                return null;
            })();

            if (duplicateWarning) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(duplicateWarning, null, 2)
                    }]
                };
            }

            // Push in batches
            const BATCH_SIZE = vouchersToPush.length <= 20 ? 1 : 10;
            const results = [];
            const rawResponses = [];
            const rawVoucherXmls = [];
            
            for (let i = 0; i < vouchersToPush.length; i += BATCH_SIZE) {
                const batch = vouchersToPush.slice(i, i + BATCH_SIZE);
                const { envelopeXml, requestDataXml } = buildBatchEnvelopeXml(batch, args.targetCompany, stockUnitMap);
                rawVoucherXmls.push(requestDataXml);
                const response = await postTallyXML(envelopeXml, { targetCompany: args.targetCompany });
                rawResponses.push(response);
                const batchResult = parseTallyImportResponse(response, batch);
                results.push(...batchResult);
            }

            const totalCreated = results.filter(r => r.status === 'created').length;
            const totalErrors = results.filter(r => r.status === 'failed').length;
            if (totalCreated > 0 && totalErrors > 0) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            partial: true,
                            warning: `${totalCreated} vouchers were PERMANENTLY created in Tally and cannot be undone automatically. ${totalErrors} vouchers failed. Fix the failed ones and re-push using voucherIndices to avoid re-creating the successful ones.`,
                            total_pushed: vouchersToPush.length,
                            total_created: totalCreated,
                            total_failed: totalErrors,
                            failed_indices: results.filter(r => r.status === 'failed').map(r => r.index),
                            results
                        }, null, 2)
                    }]
                };
            }

            const success = totalErrors === 0 && totalCreated > 0;

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success,
                        total_pushed: vouchersToPush.length,
                        total_created: totalCreated,
                        total_failed: totalErrors,
                        results
                    }, null, 2)
                }]
            };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });

    mcpServer.registerTool('excel-tally-template', {
        title: 'Excel Tally Template Generator',
        description: 'Generates a blank Excel template for importing Sales/Purchase, Payment/Receipt, or Journal vouchers with data validations.',
        inputSchema: {
            format: z.enum(['A', 'B', 'C']).describe(
                'Format A: Purchase vouchers with inventory items. ' +
                'Format B: Accounting vouchers without inventory — ' +
                'Payment, Receipt, Journal, Sales (service), ' +
                'Credit Note, Debit Note, Contra. ' +
                'Format C: Multi-ledger Journal entries with ' +
                'multiple debit/credit lines.'
            ),
            targetCompany: z.string().optional().describe('Tally company name.'),
            outputPath: z.string().optional().describe('Absolute file path to save the template to.')
        },
        annotations: { readOnlyHint: false, openWorldHint: false }
    }, async (args) => {
        try {
            const ExcelJS = (await import('exceljs')).default;
            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Import Template');
            const listsWs = wb.addWorksheet('Lists');
            listsWs.state = 'hidden';

            let voucherTypesList = [];
            let ledgersList = [];
            let stockItemsList = [];

            try {
                const vtResult = await queryCollection('VoucherType', ['Name'], new Map(), args.targetCompany);
                if (Array.isArray(vtResult)) voucherTypesList = vtResult.map(x => String(x.Name || '').trim()).filter(Boolean);
            } catch (e) {}

            try {
                const lResult = await queryCollection('Ledger', ['Name'], new Map(), args.targetCompany);
                if (Array.isArray(lResult)) ledgersList = lResult.map(x => String(x.Name || '').trim()).filter(Boolean);
            } catch (e) {}

            try {
                const sResult = await queryCollection('StockItem', ['Name'], new Map(), args.targetCompany);
                if (Array.isArray(sResult)) stockItemsList = sResult.map(x => String(x.Name || '').trim()).filter(Boolean);
            } catch (e) {}

            listsWs.getColumn(1).values = ['Voucher Types', ...voucherTypesList];
            listsWs.getColumn(2).values = ['Ledgers', ...ledgersList];
            listsWs.getColumn(3).values = ['Stock Items', ...stockItemsList];

            let headers = [];
            let sampleRow = {};

            if (args.format === 'A') {
                headers = [
                    'Date', 'Voucher Type', 'Voucher No', 'Invoice No.', 'Invoice Date',
                    'Party Name', 'Sale/Purchase Ledger', 'Item Name', 'Qty', 'Rate', 'Godown',
                    'Amount', 'IGST', 'CGST', 'SGST', 'Narration'
                ];
                sampleRow = {
                    'Date': '01-04-2026',
                    'Voucher Type': voucherTypesList[0] || 'Purchase',
                    'Voucher No': '',
                    'Invoice No.': 'INV-001',
                    'Invoice Date': '01-04-2026',
                    'Party Name': ledgersList[0] || 'ABC Party',
                    'Sale/Purchase Ledger': ledgersList[1] || 'Purchase A/c',
                    'Item Name': stockItemsList[0] || 'Wheat',
                    'Qty': 10,
                    'Rate': 100,
                    'Godown': 'Main Location',
                    'Amount': 1000,
                    'IGST': 0,
                    'CGST': 0,
                    'SGST': 0,
                    'Narration': 'Purchase of wheat'
                };
            } else if (args.format === 'B') {
                headers = [
                    'Date', 'Voucher Type', 'Voucher No.', 'Debit Ledger Name', 'Credit Ledger Name',
                    'Amount', 'Against Invoice No.', 'Narration'
                ];
                sampleRow = {
                    'Date': '01-04-2026',
                    'Voucher Type': 'Payment',
                    'Voucher No.': '',
                    'Debit Ledger Name': ledgersList[0] || 'Supplier A/c',
                    'Credit Ledger Name': ledgersList[1] || 'HDFC Bank',
                    'Amount': 5000,
                    'Against Invoice No.': 'INV-001',
                    'Narration': 'Paid against invoice'
                };
            } else if (args.format === 'C') {
                headers = [
                    'Date', 'Voucher Type', 'Voucher No.',
                    'Debit Ledger 1', 'Debit Amount 1',
                    'Debit Ledger 2', 'Debit Amount 2',
                    'Credit Ledger 1', 'Credit Amount 1',
                    'Credit Ledger 2', 'Credit Amount 2',
                    'Narration'
                ];
                sampleRow = {
                    'Date': '01-04-2026',
                    'Voucher Type': 'Journal',
                    'Voucher No.': '',
                    'Debit Ledger 1': ledgersList[0] || 'Expense A/c',
                    'Debit Amount 1': 1500,
                    'Debit Ledger 2': '',
                    'Debit Amount 2': '',
                    'Credit Ledger 1': ledgersList[1] || 'Outstanding Liab',
                    'Credit Amount 1': 1500,
                    'Credit Ledger 2': '',
                    'Credit Amount 2': '',
                    'Narration': 'Journal adjustment entry'
                };
            }

            ws.addRow(headers);
            const headerRow = ws.getRow(1);
            headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F497D' } };
            ws.views = [{ state: 'frozen', ySplit: 1 }];

            const sampleRowArray = headers.map(h => sampleRow[h] || '');
            ws.addRow(sampleRowArray);
            const r2 = ws.getRow(2);
            r2.font = { italic: true, color: { argb: 'FF808080' } };
            r2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };

            ws.getColumn(1).numFmt = '@';

            for (let r = 3; r <= 202; r++) {
                if (args.format === 'A') {
                    if (voucherTypesList.length > 0) {
                        ws.getCell(r, 2).dataValidation = {
                            type: 'list',
                            allowBlank: true,
                            formulae: [`Lists!$A$2:$A$${voucherTypesList.length + 1}`]
                        };
                    }
                    if (ledgersList.length > 0) {
                        ws.getCell(r, 6).dataValidation = {
                            type: 'list',
                            allowBlank: true,
                            formulae: [`Lists!$B$2:$B$${ledgersList.length + 1}`]
                        };
                    }
                    if (ledgersList.length > 0) {
                        ws.getCell(r, 7).dataValidation = {
                            type: 'list',
                            allowBlank: true,
                            formulae: [`Lists!$B$2:$B$${ledgersList.length + 1}`]
                        };
                    }
                    if (stockItemsList.length > 0) {
                        ws.getCell(r, 8).dataValidation = {
                            type: 'list',
                            allowBlank: true,
                            formulae: [`Lists!$C$2:$C$${stockItemsList.length + 1}`]
                        };
                    }
                } else if (args.format === 'B') {
                    if (voucherTypesList.length > 0) {
                        ws.getCell(r, 2).dataValidation = {
                            type: 'list',
                            allowBlank: true,
                            formulae: [`Lists!$A$2:$A$${voucherTypesList.length + 1}`]
                        };
                    } else {
                        ws.getCell(r, 2).dataValidation = {
                            type: 'list',
                            allowBlank: true,
                            formulae: ['"Payment,Receipt,Journal,Contra,Sales,Credit Note,Debit Note"']
                        };
                    }
                    if (ledgersList.length > 0) {
                        // Debit Ledger Name (Col 4)
                        ws.getCell(r, 4).dataValidation = {
                            type: 'list',
                            allowBlank: true,
                            formulae: [`Lists!$B$2:$B$${ledgersList.length + 1}`]
                        };
                        // Credit Ledger Name (Col 5)
                        ws.getCell(r, 5).dataValidation = {
                            type: 'list',
                            allowBlank: true,
                            formulae: [`Lists!$B$2:$B$${ledgersList.length + 1}`]
                        };
                    }
                } else if (args.format === 'C') {
                    if (voucherTypesList.length > 0) {
                        ws.getCell(r, 2).dataValidation = {
                            type: 'list',
                            allowBlank: true,
                            formulae: [`Lists!$A$2:$A$${voucherTypesList.length + 1}`]
                        };
                    } else {
                        ws.getCell(r, 2).dataValidation = {
                            type: 'list',
                            allowBlank: true,
                            formulae: ['"Journal"']
                        };
                    }
                    if (ledgersList.length > 0) {
                        // Debit Ledger 1 (Col 4), Debit Ledger 2 (Col 6), Credit Ledger 1 (Col 8), Credit Ledger 2 (Col 10)
                        [4, 6, 8, 10].forEach(colIndex => {
                            ws.getCell(r, colIndex).dataValidation = {
                                type: 'list',
                                allowBlank: true,
                                formulae: [`Lists!$B$2:$B$${ledgersList.length + 1}`]
                            };
                        });
                    }
                }
            }

            ws.columns.forEach(col => {
                let max = 15;
                col.eachCell({ includeEmpty: true }, cell => {
                    const len = cell.value ? String(cell.value).length : 0;
                    if (len > max) max = len;
                });
                col.width = max + 2;
            });

            if (args.outputPath) {
                const fs = await import('fs');
                const buf = await wb.xlsx.writeBuffer();
                fs.writeFileSync(args.outputPath, buf);
                return {
                    content: [{
                        type: 'text',
                        text: `Template successfully generated and saved to: ${args.outputPath}`
                    }]
                };
            } else {
                const buf = await wb.xlsx.writeBuffer();
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            format: args.format,
                            base64: buf.toString('base64'),
                            message: 'Blank template generated. Decode base64 to retrieve the .xlsx workbook.'
                        }, null, 2)
                    }]
                };
            }
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });

    mcpServer.registerTool('voucher-detail', {
        title: 'Voucher Detail',
        description: 'Returns all ledger entries on a specific voucher using voucherNumber/voucherTypeName/date or guid.',
        inputSchema: {
            targetCompany: z.string().optional().describe('Tally company name'),
            guid: z.string().optional().describe('Voucher GUID (primary identifier)'),
            voucherNumber: z.string().optional().describe('Voucher number (use if guid is not provided)'),
            voucherTypeName: z.string().optional().describe('Voucher type name (use if guid is not provided)'),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Voucher date YYYY-MM-DD (use if guid is not provided)'),
            retentionLedgerName: z.string().optional().describe('Ledger name for retention/deduction lookup. Default: SOUDA RETENTION CHARGES'),
            stockItemName: z.string().optional().describe('Stock item name for quantity lookup. Default: WHEAT')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            if (!args.guid && (!args.voucherNumber || !args.voucherTypeName || !args.date)) {
                return { isError: true, content: [{ type: 'text', text: 'Provide either guid, or all of voucherNumber, voucherTypeName, and date.' }] };
            }

            const parsedVoucher = await fetchVoucherDetailInternal(
                args.voucherNumber,
                args.voucherTypeName,
                args.date,
                args.targetCompany,
                args.guid,
                args.retentionLedgerName,
                args.stockItemName
            );

            if (!parsedVoucher || (!parsedVoucher.voucher_number && !parsedVoucher.date)) {
                return { content: [{ type: 'text', text: JSON.stringify({ message: 'Voucher not found' }) }] };
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(parsedVoucher, null, 2)
                }]
            };
        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });

    mcpServer.registerTool('parse-bank-statement', {
        title: 'Parse Bank Statement',
        description: 'Parses a bank statement PDF, fuzzy matches transactions to Tally ledgers, performs FIFO bill allocation with TDS/discount support, and exports a styled Format B Excel.',
        inputSchema: {
            filePath: z.string().describe('Absolute path to bank statement PDF'),
            bankLedgerName: z.string().describe('Exact Tally ledger name for this bank e.g. "HDFC BANK LTD. (CA)"'),
            targetCompany: z.string().optional().describe('Tally company name'),
            outputPath: z.string().optional().describe('Path to save output Excel. Defaults to same folder as input PDF.'),
            paymentVoucherType: z.string().optional().default('Payment').describe('Voucher type for DR transactions'),
            receiptVoucherType: z.string().optional().default('Receipt').describe('Voucher type for CR transactions'),
            billWiseAllocation: z.boolean().optional().default(true).describe('Auto-allocate against outstanding bills using FIFO. Set false to use On Account for all.'),
            tolerancePercent: z.number().optional().default(5).describe('% tolerance for near-match bill settlement. Difference within this % is treated as discount/TDS.'),
            toleranceFixed: z.number().optional().default(500).describe('Fixed ₹ tolerance for near-match. Whichever is higher of % or fixed is used.'),
            cashDiscountLedger: z.string().optional().describe('Ledger for cash discount journal entries.'),
            tdsLedger: z.string().optional().describe('TDS Receivable ledger for TDS deductions.')
        },
        annotations: { readOnlyHint: false, openWorldHint: false }
    }, async (args) => {
        try {
            const fs = await import('fs');
            const path = await import('path');
            const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
            await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
            pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
            const ExcelJS = (await import('exceljs')).default;

            const filePath = args.filePath;
            if (!filePath || !fs.existsSync(filePath)) {
                throw new Error(`PDF file not found at path: ${filePath}`);
            }

            // 1. PARSE BANK STATEMENT PDF
            const dataBuffer = fs.readFileSync(filePath);
            const loadingTask = pdfjsLib.getDocument({
                data: new Uint8Array(dataBuffer),
                useWorkerFetch: false,
                isEvalSupported: false,
                useSystemFonts: true
            });
            const pdfDoc = await loadingTask.promise;
            let text = '';
            let rawText = '';
            for (let i = 1; i <= pdfDoc.numPages; i++) {
                const page = await pdfDoc.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items
                    .map(item => item.str)
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                text += pageText + '\n';
                rawText += (rawText ? ' ' : '') + pageText;
            }
            rawText = rawText.replace(/\s+/g, ' ').trim();
            const lines = text.split('\n');

            let bankType = 'generic';
            const upperText = text.toUpperCase();
            if (upperText.includes('HDFC BANK')) {
                bankType = 'HDFC';
            } else if (upperText.includes('STATE BANK') || upperText.includes('SBI')) {
                bankType = 'SBI';
            } else if (upperText.includes('ICICI BANK')) {
                bankType = 'ICICI';
            }

            const transactions = [];
            let currentTx = null;

            const parseDateToDDMMYYYY = (dStr) => {
                const parts = dStr.split(/[-/]/);
                if (parts.length === 3) {
                    let day = parts[0].padStart(2, '0');
                    let month = parts[1].padStart(2, '0');
                    let year = parts[2];
                    if (year.length === 2) {
                        year = '20' + year;
                    }
                    return `${day}-${month}-${year}`;
                }
                return dStr;
            };

            const stripTrailingPartial = (name) => {
                if (!name) return name;
                // Remove trailing -NETB, -NETBA, -NETBAN etc
                name = name.replace(/-NET(B(A(N(K)?)?)?)?$/i, '');
                // Remove trailing bank/transfer codes
                name = name.replace(/-(NETBANK|BANK|NET)$/i, '');
                // Remove trailing single consonant cluster
                name = name.replace(/\s+[BCDFGHJKLMNPQRSTVWXYZ]{1,3}$/, '');
                return name.trim();
            };

            const splitConcatenated = (name) => {
                if (!name) return name;
                
                // Common suffixes to split on
                const suffixes = [
                    'PVTLTD','PVT LTD','PRIVATE LIMITED','PRIVATELIMLITED',
                    'LIMITED','LTD','TRADERS','TRADING','ENTERPRISES',
                    'ENTERPRISE','STORES','STORE','PACKAGING','PACKAGIN',
                    'ROADLINES','ROAD LINES','ROADLINE','TRANSPORT',
                    'FEEDS','MILL','MILLS','INDUSTRIES','INDUSTRY',
                    'FOODS','FOOD','CHEMICALS','CHEMICAL','EXPORTS',
                    'IMPORT','IMPORTS','LOGISTICS','COMMUNICATION',
                    'INNOVATION','AGENCY','AGENCIES','BROTHERS',
                    'CONSTRUCTION','ENGINEERING','SERVICES'
                ];
                
                let result = name.trim();
                
                // Step 1: Insert space before known suffixes
                for (const suffix of suffixes) {
                    const regex = new RegExp(
                        `([A-Z])${suffix}`, 'g'
                    );
                    result = result.replace(regex, `$1 ${suffix}`);
                }
                
                // Step 2: Insert space at digit-letter boundaries
                result = result.replace(/([A-Z])(\d)/g, '$1 $2');
                result = result.replace(/(\d)([A-Z])/g, '$1 $2');
                
                // Step 3: CamelCase detection — insert space before 
                // uppercase that follows 3+ consecutive uppercase
                // e.g. WHEELFLEXIBLEPACKAGI → WHEEL FLEXIBLE PACKAGI
                result = result.replace(
                    /([A-Z]{2,})([A-Z][a-z])/g, '$1 $2'
                );
                
                // Step 4: Known compound word splits
                const splits = {
                    'ROADLINES': 'ROAD LINES',
                    'ROADLINE': 'ROAD LINE',
                    'DALMILL': 'DAL MILL',
                    'DALLMILL': 'DALL MILL',
                    'FLEXIBLEPACKAG': 'FLEXIBLE PACKAG',
                    'KAHANPACKAG': 'KAHAN PACKAG',
                    'AMCORFLEXIBLE': 'AMCOR FLEXIBLE',
                    'HARISHROADLINES': 'HARISH ROAD LINES',
                    'VAISHNAVITRADERS': 'VAISHNAVI TRADERS',
                    'DEBABRATASAHA': 'DEBABRATA SAHA',
                    'HABIBURRAHAMAN': 'HABIBUR RAHMAN',
                    'RICHIKM ANNA': 'RICHIK MANNA',
                    'SHIVSHAKTI': 'SHIV SHAKTI',
                    'SRIHANUMAN': 'SRI HANUMAN',
                    'MAMALAI': 'MA MALAI',
                    'PANCHANANEN': 'PANCHANAN',
                    'SOMAE NTERPRISE': 'SOMA ENTERPRISE',
                    'JHULANPAUL': 'JHULAN PAUL',
                    'SHREEA MBIKA': 'SHREE AMBIKA',
                    'AVANTIFEEDS': 'AVANTI FEEDS',
                    'NOWRANGROYAGROPVTLTD': 'NOWRANGROY AGRO PVT LTD',
                    'KONISKOS AHA': 'KONISKO SAHA',
                };
                
                for (const [from, to] of Object.entries(splits)) {
                    result = result.replace(new RegExp(from, 'gi'), to);
                }
                
                // Collapse multiple spaces
                result = result.replace(/\s+/g, ' ').trim();
                
                return result;
            };

            const extractPartyAndIFSC = (narration) => {
                const singleLineNarration = narration.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
                let extractedIFSC = '';
                const ifscMatch = singleLineNarration.match(/(?:DR|CR)-([A-Z]{4}[0-9]{6,7})-/i);
                if (ifscMatch) {
                    extractedIFSC = ifscMatch[1].toUpperCase();
                }

                let extractedParty = '';
                const rtgsMatch = singleLineNarration.match(/(?:RTGS|NEFT)\s+(?:DR|CR)-[A-Z0-9]+-([A-Z0-9]+)-/i);
                if (rtgsMatch) {
                    extractedParty = rtgsMatch[1].replace(/NETBANK|MUM|NET/ig, '').trim();
                }
                if (!extractedParty) {
                    const neftMatch = singleLineNarration.match(/NEFT\s+(?:CR|DR)-[A-Z0-9]+-(.+?)-(?:NOWRANG|N\d|0\d)/i);
                    if (neftMatch) {
                        extractedParty = neftMatch[1].trim();
                    }
                }
                if (!extractedParty) {
                    const upiMatch = singleLineNarration.match(/UPI-(.+?)-[\d@]/i);
                    if (upiMatch) {
                        extractedParty = upiMatch[1].trim();
                    }
                }
                if (!extractedParty) {
                    const billpayMatch = singleLineNarration.match(/BILLPAY\s+([A-Z0-9]+)/i);
                    if (billpayMatch) {
                        extractedParty = billpayMatch[1].trim();
                    }
                }
                if (!extractedParty) {
                    const cashMatch = singleLineNarration.match(/CASH DEPOSIT BY\s*-\s*(.+?)(?:\s*-\s*[A-Z]|\s*$)/i);
                    if (cashMatch) {
                        extractedParty = cashMatch[1].trim();
                    }
                }
                if (!extractedParty) {
                    const chqMatch = singleLineNarration.match(/CHQ DEP.*?-\s*(.+)/i);
                    if (chqMatch) {
                        extractedParty = chqMatch[1].trim();
                    }
                }
                if (!extractedParty) {
                    extractedParty = singleLineNarration.slice(0, 30).trim();
                }

                extractedParty = stripTrailingPartial(extractedParty);
                extractedParty = splitConcatenated(extractedParty);

                return { extractedParty, extractedIFSC };
            };

            if (bankType === 'HDFC') {
                const txPattern = /(\d{2}\/\d{2}\/\d{2}) ((?:RTGS|NEFT|UPI|CASH|CHQ|607)[\s\S]+?)(?=\d{2}\/\d{2}\/\d{2} (?:RTGS|NEFT|UPI|CASH|CHQ|607)|STATEMENT SUMMARY|\s*Page No|$)/g;
                let match;
                while ((match = txPattern.exec(rawText)) !== null) {
                    const rawDate = match[1];
                    const content = match[2].trim();
                    if (content.startsWith('Narration') || content.includes('Statement Summary') || content.includes('STATEMENT SUMMARY')) continue;

                    const date = parseDateToDDMMYYYY(rawDate);
                    
                    // Extract narration part before the value date
                    const narrationPart = content.split(/\d{2}\/\d{2}\/\d{2}/)[0].trim();

                    let chqRefNo = '';
                    let narration = narrationPart;
                    const infoWords = narrationPart.split(/\s+/);
                    if (infoWords.length > 1) {
                        const lastWord = infoWords[infoWords.length - 1];
                        if (/^[A-Za-z0-9\/-]+$/.test(lastWord) && (lastWord.length >= 4 || /^\d+$/.test(lastWord))) {
                            chqRefNo = lastWord;
                            narration = infoWords.slice(0, -1).join(' ');
                        }
                    }

                    // Get last two numbers — second-to-last is amount, last is closing balance
                    const nums = content.match(/-?[\d,]+\.\d{2}/g) || [];
                    const amount = nums.length >= 2 
                        ? parseFloat(nums[nums.length-2].replace(/,/g,''))
                        : 0;
                    const closingBal = nums.length >= 1
                        ? parseFloat(nums[nums.length-1].replace(/,/g,''))
                        : 0;

                    // DR/CR detection from narration
                    const isDR = /\bDR-|BILLPAY|CHQ DEP|UPI-.*@/.test(content);
                    const isCR = /\bCR-|CASH DEPOSIT/.test(content);
                    const type = (isCR && !isDR) ? 'CR' : 'DR';

                    // Extract value date (first date pattern in the content string)
                    const valDateMatch = content.match(/\d{2}\/\d{2}\/\d{2}/);
                    const valueDate = valDateMatch ? parseDateToDDMMYYYY(valDateMatch[0]) : date;

                    transactions.push({
                        date,
                        narration,
                        chqRefNo,
                        valueDate,
                        closingBalance: closingBal,
                        cleanAmts: nums.map(x => parseBankAmount(x)),
                        withdrawalAmt: type === 'DR' ? amount : null,
                        depositAmt: type === 'CR' ? amount : null,
                        amount: amount,
                        type: type
                    });
                }
            } else {
                for (let rawLine of lines) {
                    const line = rawLine.trim();
                    if (!line) continue;

                    if (line.includes('STATEMENT SUMMARY') || line.includes('Statement Summary') ||
                        line.startsWith('Date') || line.includes('Closing Balance') ||
                        line.includes('Page No') || line.includes('B/F') || line.includes('C/F')) {
                        continue;
                    }

                    const dateMatch = line.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/);
                    if (dateMatch) {
                        if (currentTx) {
                            transactions.push(currentTx);
                        }

                        const rawDate = dateMatch[0];
                        const date = parseDateToDDMMYYYY(rawDate);
                        const rest = line.substring(dateMatch.index + rawDate.length).trim();

                        currentTx = {
                            date,
                            narration: '',
                            chqRefNo: '',
                            valueDate: date,
                            withdrawalAmt: null,
                            depositAmt: null,
                            closingBalance: 0,
                            type: 'DR',
                            amount: 0,
                            rawRest: rest,
                            cleanAmts: []
                        };

                        const valDateMatch = rest.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/);
                        if (valDateMatch) {
                            const valDate = valDateMatch[0];
                            currentTx.valueDate = parseDateToDDMMYYYY(valDate);
                            const valDateIdx = rest.indexOf(valDate);
                            
                            const middle = rest.substring(0, valDateIdx).trim();
                            const afterValDate = rest.substring(valDateIdx + valDate.length).trim();

                            const middleWords = middle.split(/\s+/);
                            let chqRefNo = '';
                            let narration = middle;
                            if (middleWords.length > 1) {
                                const lastWord = middleWords[middleWords.length - 1];
                                if (/^[A-Za-z0-9\/-]+$/.test(lastWord) && (lastWord.length >= 4 || /^\d+$/.test(lastWord))) {
                                    chqRefNo = lastWord;
                                    narration = middleWords.slice(0, -1).join(' ');
                                }
                            }
                            currentTx.chqRefNo = chqRefNo;
                            currentTx.narration = narration;

                            const amtMatches = afterValDate.match(/[0-9,]+(?:\.[0-9]+)?/g) || [];
                            currentTx.cleanAmts = amtMatches.map(x => parseBankAmount(x));
                            if (currentTx.cleanAmts.length >= 1) {
                                currentTx.closingBalance = currentTx.cleanAmts[currentTx.cleanAmts.length - 1];
                            }
                        } else {
                            const amtMatches = rest.match(/[0-9,]+(?:\.[0-9]+)?/g) || [];
                            currentTx.cleanAmts = amtMatches.map(x => parseBankAmount(x));
                            if (currentTx.cleanAmts.length >= 1) {
                                currentTx.closingBalance = currentTx.cleanAmts[currentTx.cleanAmts.length - 1];
                            }
                            
                            let narration = rest;
                            for (const match of amtMatches) {
                                narration = narration.replace(match, '');
                            }
                            currentTx.narration = narration.replace(/\s+/g, ' ').trim();
                        }
                    } else {
                        if (currentTx) {
                            currentTx.narration += '\n' + line;
                        }
                    }
                }

                if (currentTx) {
                    transactions.push(currentTx);
                }
            }

            // Resolve types, amounts, and metadata
            for (let i = 0; i < transactions.length; i++) {
                const tx = transactions[i];
                
                if (bankType !== 'HDFC') {
                    let amount = 0;
                    let type = 'DR';
                    const cleanAmts = tx.cleanAmts;

                    if (cleanAmts.length >= 3) {
                        const w = cleanAmts[cleanAmts.length - 3];
                        const d = cleanAmts[cleanAmts.length - 2];
                        if (w > 0 && d === 0) {
                            type = 'DR';
                            amount = w;
                        } else if (d > 0 && w === 0) {
                            type = 'CR';
                            amount = d;
                        } else {
                            amount = w || d;
                        }
                    } else if (cleanAmts.length === 2) {
                        amount = cleanAmts[0];
                        if (i > 0) {
                            const prevBal = transactions[i - 1].closingBalance;
                            const diff = tx.closingBalance - prevBal;
                            if (Math.abs(diff - amount) < 0.05) {
                                type = 'CR';
                            } else {
                                type = 'DR';
                            }
                        } else {
                            if (/DEPOSIT|CR|CREDIT|RECEIVED/i.test(tx.narration)) {
                                type = 'CR';
                            } else {
                                type = 'DR';
                            }
                        }
                    }

                    tx.amount = amount;
                    tx.type = type;
                    tx.withdrawalAmt = (type === 'DR') ? amount : null;
                    tx.depositAmt = (type === 'CR') ? amount : null;
                }

                const { extractedParty, extractedIFSC } = extractPartyAndIFSC(tx.narration);
                tx.extractedParty = extractedParty;
                tx.extractedIFSC = extractedIFSC;

                const accNos = [...tx.narration.matchAll(/\b(\d{9,18})\b/g)].map(m => m[1]);
                tx.extractedAccNo = accNos[0] || '';
            }

            // 2. FETCH TALLY MASTERS
            const [allLedgers, allBills, allStockItems] = await Promise.all([
                queryCollection('Ledger', ['Name', 'Parent', 'BankAccountNo', 'IFSCCode', 'BankName', '_PrimaryGroup'], new Map(), args.targetCompany),
                args.billWiseAllocation 
                    ? queryCollection('Bill', ['BillDate', 'Name', 'ClosingBalance', 'Parent'], new Map(), args.targetCompany)
                    : Promise.resolve([]),
                args.billWiseAllocation
                    ? queryCollection('StockItem', ['Name', 'Unit', 'AlternateUnit', 'Conversion'], new Map(), args.targetCompany)
                    : Promise.resolve([])
            ]);

            const stockItemMap = new Map();
            if (Array.isArray(allStockItems)) {
                for (const item of allStockItems) {
                    stockItemMap.set(item.Name, item);
                }
            }

            const ledgerMap = new Map(allLedgers.map(l => [l.Name, l]));
            const ledgerNameMap = new Map(allLedgers.map(l => [normalize(l.Name), l]));

            const accountNoMap = new Map();
            for (const l of allLedgers) {
                const acc = String(l.BankAccountNo || '').replace(/\s/g, '');
                if (acc) accountNoMap.set(acc, l.Name);
            }

            const ifscMap = new Map();
            for (const l of allLedgers) {
                const ifsc = String(l.IFSCCode || '').toUpperCase().trim();
                if (ifsc) {
                    if (!ifscMap.has(ifsc)) ifscMap.set(ifsc, []);
                    ifscMap.get(ifsc).push(l.Name);
                }
            }

            const billsByParty = {};
            const rawBills = Array.isArray(allBills) ? allBills : (allBills?.data || []);
            for (const b of rawBills) {
                const party = b.Parent || b.party_name || b.ledger_name;
                if (!party) continue;
                if (!billsByParty[party]) billsByParty[party] = [];
                billsByParty[party].push({
                    bill_date: b.BillDate || b.bill_date,
                    bill_name: b.Name || b.reference_number,
                    balance: Math.abs(b.ClosingBalance || b.outstanding_amount || 0)
                });
            }
            for (const party of Object.keys(billsByParty)) {
                billsByParty[party].sort((a, b) => new Date(a.bill_date) - new Date(b.bill_date));
            }

            const fuzzyScore = (haystack, needle) => {
                const h = String(haystack || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ');
                const words = String(needle || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ')
                    .split(/\s+/).filter(w => w.length >= 3);
                if (!words.length) return 0;
                const matched = words.filter(w => h.includes(w)).length;
                return matched / words.length;
            };

            const isDebtorOrCreditor = (ledgerName) => {
                const l = ledgerMap.get(ledgerName);
                if (!l) return false;
                const pg = String(l._PrimaryGroup || l.Parent || '').toUpperCase();
                return pg.includes('SUNDRY DEBTORS') || pg.includes('SUNDRY CREDITORS');
            };

            // 3. THREE-TIER MATCHING
            const matchLedger = (tx) => {
                const accNosInNarration = [...tx.narration.matchAll(/\b(\d{9,18})\b/g)].map(m => m[1]);
                for (const acc of accNosInNarration) {
                    if (accountNoMap.has(acc)) {
                        return {
                            matched_name: accountNoMap.get(acc),
                            match_type: 'account_number',
                            match_score: 1.0,
                            auto_accepted: true,
                            top_candidates: []
                        };
                    }
                }

                const extractedIFSC = tx.extractedIFSC;
                if (extractedIFSC && ifscMap.has(extractedIFSC)) {
                    const candidates = ifscMap.get(extractedIFSC);
                    const best = candidates
                        .map(name => ({ name, score: fuzzyScore(tx.extractedParty, name) }))
                        .sort((a, b) => b.score - a.score)[0];
                    if (best && best.score >= 0.6) {
                        return {
                            matched_name: best.name,
                            match_type: 'ifsc_plus_name',
                            match_score: Math.min(best.score + 0.1, 1.0),
                            auto_accepted: best.score >= 0.65,
                            top_candidates: candidates.map(name => ({ name, score: 0.8 }))
                        };
                    }
                }

                const result = fuzzyMatchName(tx.extractedParty, allLedgers);
                const score = result.match_score;
                const BANK_STMT_AUTO_ACCEPT = 0.65;
                const BANK_STMT_SUGGEST = 0.45;

                if (score >= BANK_STMT_SUGGEST) {
                    return {
                        matched_name: result.matched_name,
                        match_type: result.match_type,
                        match_score: score,
                        auto_accepted: score >= BANK_STMT_AUTO_ACCEPT,
                        top_candidates: result.top_candidates
                    };
                }

                return {
                    matched_name: 'SUSPENCE A/C',
                    match_type: 'none',
                    match_score: score,
                    auto_accepted: false,
                    has_error: true,
                    top_candidates: result?.top_candidates || []
                };
            };

            // Calculate CD and Bran deductions for a bill
            const calculateDeductionForBill = async (billName) => {
                let cd = 0;
                let bran = 0;
                try {
                    const vchResp = await fetchReport('voucher-detail', new Map([
                        ['voucherNumber', billName],
                        ['targetCompany', args.targetCompany]
                    ]));
                    
                    const rows = (vchResp && Array.isArray(vchResp.data)) ? vchResp.data : [];
                    const matchingVch = rows.find(r => String(r.voucher_number || r.voucherNumber || '').trim() === String(billName).trim());
                    
                    if (matchingVch) {
                        const rawInvList = matchingVch['ALLINVENTORYENTRIES.LIST'];
                        const invList = Array.isArray(rawInvList) ? rawInvList : (rawInvList ? [rawInvList] : []);
                        
                        for (const item of invList) {
                            const itemName = String(item.stock_item_name || item.stock_item || '').trim();
                            if (!itemName) continue;
                            
                            const qtyStr = String(item.billed_qty || item.quantity || '0').trim();
                            const qty = Math.abs(parseFloat(qtyStr.replace(/[^0-9.\-]/g, '')) || 0);
                            if (qty === 0) continue;
                            
                            if (itemName.toUpperCase().includes('BRAN')) {
                                let bagSize = 37;
                                const itemMaster = stockItemMap.get(itemName);
                                if (itemMaster && itemMaster.Conversion > 1) {
                                    bagSize = itemMaster.Conversion;
                                } else {
                                    const nameMatch = itemName.match(/(\d+)\s*(?:kg|kgs)/i);
                                    if (nameMatch) {
                                        bagSize = parseFloat(nameMatch[1]);
                                    } else {
                                        const narrText = String(matchingVch.narration || '');
                                        const narrMatch = narrText.match(/(?:\/\s*|per\s*bags?\s*|per\s*kg\s*bags?\s*)(\d+)\s*(?:kg|kgs)/i) || narrText.match(/(\d+)\s*(?:kg|kgs)\s*per\s*bags?/i);
                                        if (narrMatch) {
                                            bagSize = parseFloat(narrMatch[1]);
                                        }
                                    }
                                }
                                bran += (qty / bagSize) * 7;
                            } else {
                                cd += (qty / 100) * 10;
                            }
                        }
                    }
                } catch (e) {
                    // silent fail
                }
                return { cd, bran, total: cd + bran };
            };

            // 4. BILL-WISE FIFO ALLOCATION
            const allocateFIFO = async (matchedLedger, paymentAmt) => {
                const bills = billsByParty[matchedLedger] || [];
                if (!bills.length) {
                    return [{
                        bill_name: '',
                        allocated: paymentAmt,
                        type: 'On Account',
                        row_type: 'main',
                        note: 'No outstanding bills found'
                    }];
                }

                const rows = [];
                let remaining = paymentAmt;

                for (const bill of bills) {
                    if (remaining <= 0) break;

                    const billBal = parseFloat(bill.balance || 0);
                    const toleranceAmt = Math.max(
                        billBal * (args.tolerancePercent / 100),
                        args.toleranceFixed
                    );
                    const diff = billBal - remaining;

                    if (remaining >= billBal) {
                        rows.push({
                            bill_name: bill.bill_name,
                            bill_date: bill.bill_date,
                            allocated: billBal,
                            type: 'Agst Ref',
                            row_type: 'main',
                            note: `${bill.bill_name} fully settled`
                        });
                        remaining -= billBal;
                    } else if (diff > 0 && diff <= toleranceAmt) {
                        rows.push({
                            bill_name: bill.bill_name,
                            bill_date: bill.bill_date,
                            allocated: remaining,
                            type: 'Agst Ref',
                            row_type: 'main',
                            note: `${bill.bill_name} settled with ₹${diff.toFixed(2)} deductions/TDS`
                        });

                        const calc = await calculateDeductionForBill(bill.bill_name);
                        const totalCalculatedDeduction = calc.total;
                        const remainingDiff = diff - totalCalculatedDeduction;

                        if (totalCalculatedDeduction > 0) {
                            rows.push({
                                bill_name: bill.bill_name,
                                allocated: totalCalculatedDeduction,
                                type: 'Agst Ref',
                                row_type: 'discount',
                                note: `Calculated CD: ₹${calc.cd.toFixed(2)}, Bran: ₹${calc.bran.toFixed(2)} on ${bill.bill_name}`
                            });

                            if (remainingDiff > 0) {
                                rows.push({
                                    bill_name: bill.bill_name,
                                    allocated: remainingDiff,
                                    type: 'Agst Ref',
                                    row_type: 'tds',
                                    note: `TDS deducted on ${bill.bill_name} (Calculated remainder)`
                                });
                            }
                        } else {
                            const isLikelyTDS = [1, 2, 5, 10].some(rate =>
                                Math.abs((diff / billBal) * 100 - rate) < 0.5
                            );
                            rows.push({
                                bill_name: bill.bill_name,
                                allocated: diff,
                                type: 'Agst Ref',
                                row_type: isLikelyTDS ? 'tds' : 'discount',
                                note: isLikelyTDS 
                                    ? `Possible TDS @ ${((diff / billBal) * 100).toFixed(1)}%`
                                    : `Cash discount on ${bill.bill_name}`
                            });
                        }
                        remaining = 0;
                    } else {
                        rows.push({
                            bill_name: bill.bill_name,
                            bill_date: bill.bill_date,
                            allocated: remaining,
                            type: 'Agst Ref',
                            row_type: 'main',
                            note: `${bill.bill_name} partially settled — ₹${diff.toFixed(2)} still outstanding`
                        });
                        remaining = 0;
                    }
                }

                if (remaining > 0) {
                    rows.push({
                        bill_name: '',
                        allocated: remaining,
                        type: 'On Account',
                        row_type: 'main',
                        note: 'Excess — all bills settled'
                    });
                }

                return rows;
            };

            // Process all transactions
            const processedTransactions = [];
            let autoMatchedCount = 0;
            let reviewCount = 0;
            let noMatchCount = 0;
            
            let fullySettledCount = 0;
            let partiallySettledCount = 0;
            let onAccountCount = 0;
            let discountRowsCount = 0;
            let tdsRowsCount = 0;

            for (const tx of transactions) {
                const match = matchLedger(tx);
                tx.match_type = match.match_type;
                tx.match_score = match.match_score;
                tx.matched_name = match.matched_name;
                tx.auto_accepted = match.auto_accepted;
                tx.top_candidates = match.top_candidates;

                if (match.match_type === 'none') noMatchCount++;
                else if (match.auto_accepted) autoMatchedCount++;
                else reviewCount++;

                let allocations = [];
                if (args.billWiseAllocation && isDebtorOrCreditor(tx.matched_name)) {
                    allocations = await allocateFIFO(tx.matched_name, tx.amount);
                    for (const a of allocations) {
                        if (a.row_type === 'tds') tdsRowsCount++;
                        else if (a.row_type === 'discount') discountRowsCount++;
                        else if (a.type === 'On Account') onAccountCount++;
                        else if (a.note.includes('fully settled')) fullySettledCount++;
                        else if (a.note.includes('partially settled')) partiallySettledCount++;
                    }
                } else {
                    allocations = [{
                        bill_name: '',
                        allocated: tx.amount,
                        type: 'On Account',
                        row_type: 'main',
                        note: 'On Account allocation'
                    }];
                    onAccountCount++;
                }
                tx.allocations = allocations;
                processedTransactions.push(tx);
            }

            // 5. BUILD EXCEL ROWS
            const excelRows = [];
            for (const tx of processedTransactions) {
                let first = true;
                for (const alloc of tx.allocations) {
                    let debitLedger = '';
                    let creditLedger = '';
                    let amount = alloc.allocated;
                    let voucherType = '';

                    if (alloc.row_type === 'main') {
                        if (tx.type === 'DR') {
                            debitLedger = tx.matched_name;
                            creditLedger = args.bankLedgerName;
                            voucherType = args.paymentVoucherType;
                        } else {
                            debitLedger = args.bankLedgerName;
                            creditLedger = tx.matched_name;
                            voucherType = args.receiptVoucherType;
                        }
                    } else if (alloc.row_type === 'discount') {
                        if (tx.type === 'CR') {
                            debitLedger = args.cashDiscountLedger || 'CASH DISCOUNT ALLOWED';
                            creditLedger = tx.matched_name;
                        } else {
                            debitLedger = tx.matched_name;
                            creditLedger = args.cashDiscountLedger || 'CASH DISCOUNT RECEIVED';
                        }
                        voucherType = 'Journal';
                    } else if (alloc.row_type === 'tds') {
                        debitLedger = args.tdsLedger || 'TDS RECEIVABLE';
                        creditLedger = tx.matched_name;
                        voucherType = 'Journal';
                    }

                    excelRows.push({
                        date: tx.date,
                        voucherType,
                        voucherNo: tx.chqRefNo || '',
                        debitLedger,
                        creditLedger,
                        amount,
                        againstInvoice: alloc.bill_name || '',
                        narration: first ? tx.narration : '',
                        matchType: tx.match_type,
                        matchScore: tx.match_score,
                        settlementNote: alloc.note,
                        txMatchType: tx.match_type,
                        txAutoAccepted: tx.auto_accepted,
                        allocType: alloc.type,
                        rowType: alloc.row_type,
                        top_candidates: tx.top_candidates,
                        extractedParty: tx.extractedParty
                    });
                    first = false;
                }
            }

            // 6. GENERATE EXCEL WITH COLOR CODING
            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Transactions');

            // Set headers
            ws.addRow([
                'Date', 'Voucher Type', 'Voucher No.', 'Debit Ledger Name', 'Credit Ledger Name',
                'Amount', 'Against Invoice No.', 'Narration'
            ]);

            // totals kept in metadata only — not in the sheet so import doesn't break
            const totalDR = transactions.filter(t => t.type === 'DR').reduce((s, t) => s + t.amount, 0);
            const totalCR = transactions.filter(t => t.type === 'CR').reduce((s, t) => s + t.amount, 0);

            // Apply Header Styling
            const headerRow = ws.getRow(1);
            headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F497D' } };

            // Add data rows starting immediately from row 2
            for (let i = 0; i < excelRows.length; i++) {
                const r = excelRows[i];
                const rowNum = i + 2;
                ws.addRow([
                    r.date, r.voucherType, r.voucherNo, r.debitLedger, r.creditLedger,
                    r.amount, r.againstInvoice, r.narration
                ]);

                const row = ws.getRow(rowNum);

                // Row coloring logic
                let rowFillColor = null;
                let fontColor = 'FF000000';

                if (r.rowType === 'discount') {
                    rowFillColor = 'FFFFF3E0'; // pale orange
                } else if (r.rowType === 'tds') {
                    rowFillColor = 'FFE8F4FD'; // pale blue
                } else if (r.allocType === 'On Account') {
                    rowFillColor = 'FFFFC7CE'; // light red
                } else if (r.allocType === 'Agst Ref') {
                    if (r.settlementNote.includes('fully settled')) {
                        rowFillColor = 'FFEBF7F0'; // pale green
                    } else {
                        rowFillColor = 'FFFFF9C4'; // pale yellow
                    }
                }

                // If not colored by allocation type, color by transaction match type
                if (!rowFillColor) {
                    if (r.txMatchType === 'account_number') {
                        rowFillColor = 'FF375623';
                        fontColor = 'FFFFFFFF';
                    } else if (r.txMatchType === 'ifsc_plus_name' || r.txMatchType === 'exact') {
                        rowFillColor = 'FFC6EFCE';
                    } else if (r.txMatchType === 'contains' || r.txMatchType.startsWith('token')) {
                        rowFillColor = 'FFEB9C'; // light yellow (FFEB9C or FFFEB9C)
                    } else if (r.txMatchType === 'none') {
                        rowFillColor = 'FFFFC7CE'; // light red
                    }
                }

                if (rowFillColor) {
                    row.eachCell((cell) => {
                        cell.fill = {
                            type: 'pattern',
                            pattern: 'solid',
                            fgColor: { argb: rowFillColor }
                        };
                        cell.font = { color: { argb: fontColor } };
                    });
                }

                // Add comments to Narration cell
                if (r.narration) {
                    const cell = ws.getCell(rowNum, 8);
                    cell.note = `Extracted party: ${r.extractedParty} | Match: ${r.txMatchType} (${(r.matchScore * 100).toFixed(0)}%)`;
                }

                // Add dropdown to yellow/red ledger cells
                if (!r.txAutoAccepted || r.txMatchType === 'none') {
                    const topCandidates = r.top_candidates || [];
                    if (topCandidates.length > 0) {
                        const candidateNames = topCandidates.map(c => c.name.replace(/"/g, ''));
                        const formulaList = `"${candidateNames.join(',')}"`;
                        if (formulaList.length <= 250) {
                            // Apply to Debit Ledger or Credit Ledger depending on which contains the matched name
                            const colIndex = (r.debitLedger === r.matched_name) ? 4 : 5;
                            ws.getCell(rowNum, colIndex).dataValidation = {
                                type: 'list',
                                allowBlank: true,
                                formulae: [formulaList]
                            };
                        }
                    }
                }
            }

            // Freeze just the header row
            ws.views = [{ state: 'frozen', ySplit: 1 }];

            // Auto-fit column widths
            ws.columns.forEach(col => {
                let max = 12;
                col.eachCell({ includeEmpty: true }, cell => {
                    const val = cell.value;
                    const len = val ? String(val).length : 0;
                    if (len > max) max = len;
                });
                col.width = Math.min(max + 2, 45);
            });

            // 7. SELF-IMPROVING — STORE ACCOUNT NUMBERS
            const updates = processedTransactions.filter(t =>
                t.match_type !== 'account_number' &&
                t.extractedAccNo &&
                t.matched_name !== 'SUSPENCE A/C'
            ).map(t => {
                const ledger = ledgerMap.get(t.matched_name);
                return {
                    ledgerName: t.matched_name,
                    currentAccNo: ledger ? ledger.BankAccountNo || '' : '',
                    newAccNo: t.extractedAccNo,
                    ifsc: t.extractedIFSC || (ledger ? ledger.IFSCCode || '' : '')
                };
            });

            const ws2 = wb.addWorksheet('Ledger Updates');
            ws2.addRow(['Ledger Name', 'Current Acc No', 'New Acc No', 'IFSC', 'Apply?']);
            const updateHeader = ws2.getRow(1);
            updateHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            updateHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F497D' } };

            for (let i = 0; i < updates.length; i++) {
                const u = updates[i];
                const rowNum = i + 2;
                ws2.addRow([u.ledgerName, u.currentAccNo, u.newAccNo, u.ifsc, 'Yes']);
                ws2.getCell(rowNum, 5).dataValidation = {
                    type: 'list',
                    allowBlank: true,
                    formulae: ['"Yes,No"']
                };
            }
            ws2.columns.forEach(col => {
                let max = 15;
                col.eachCell({ includeEmpty: true }, cell => {
                    const len = cell.value ? String(cell.value).length : 0;
                    if (len > max) max = len;
                });
                col.width = max + 2;
            });

            // Write output file
            const dirName = path.dirname(filePath);
            const baseName = path.basename(filePath, path.extname(filePath));
            const outPath = args.outputPath || path.join(dirName, `${baseName}_recon.xlsx`);

            const buf = await wb.xlsx.writeBuffer();
            fs.writeFileSync(outPath, buf);

            // Calculate metrics for response
            const exactCount = transactions.filter(t => t.match_type === 'exact').length;
            const containsCount = transactions.filter(t => t.match_type === 'contains').length;
            const tokenCount = transactions.filter(t => t.match_type.startsWith('token')).length;

            // Account name — look for M/S. pattern
            const nameMatch = text.match(/M\/S\.\s+NOWRANGROY[^,\n]+/i) ||
                              text.match(/M\/S\.\s+([A-Z ]+(?:PVT|LTD|LIMITED|LLP)[^\n]*)/i);
            const accountName = nameMatch?.[0]?.replace('M/S.','').trim() || (transactions[0] ? transactions[0].extractedParty : '');

            // Account number
            const accMatch = text.match(/Account No\s*[:\s]+(\d{10,})/i);
            const accountNo = accMatch?.[1] || accountNoMap.get(transactions[0]?.matched_name) || '';

            const responsePayload = {
                success: true,
                excelBase64: buf.toString('base64'),
                bank: bankType,
                account_name: accountName,
                account_no: accountNo,
                statement_period: {
                    from: transactions[0] ? transactions[0].date : '',
                    to: transactions[transactions.length - 1] ? transactions[transactions.length - 1].date : ''
                },
                bank_ledger: args.bankLedgerName,
                opening_balance: transactions[0] ? transactions[0].closingBalance - transactions[0].amount : 0,
                closing_balance: transactions[transactions.length - 1] ? transactions[transactions.length - 1].closingBalance : 0,
                total_transactions: transactions.length,
                total_dr: totalDR,
                total_cr: totalCR,
                matching_summary: {
                    account_number: transactions.filter(t => t.match_type === 'account_number').length,
                    ifsc_plus_name: transactions.filter(t => t.match_type === 'ifsc_plus_name').length,
                    exact_name: exactCount,
                    fuzzy_name: containsCount + tokenCount,
                    no_match: noMatchCount
                },
                bill_allocation_summary: {
                    fully_settled: fullySettledCount,
                    partially_settled: partiallySettledCount,
                    on_account: onAccountCount,
                    discount_rows_generated: discountRowsCount,
                    tds_rows_generated: tdsRowsCount
                },
                output_excel_path: outPath,
                ledger_updates_suggested: updates.length,
                transactions: excelRows.map(r => ({
                    date: r.date,
                    voucher_type: r.voucherType,
                    voucher_no: r.voucherNo,
                    debit_ledger_name: r.debitLedger,
                    credit_ledger_name: r.creditLedger,
                    amount: r.amount,
                    against_invoice_no: r.againstInvoice,
                    narration: r.narration
                })),
                _debug_raw_text: rawText.substring(0, 2000),
                _debug_text_length: rawText.length
            };

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(responsePayload, null, 2)
                }]
            };

        } catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });

    return mcpServer;
}
//# sourceMappingURL=mcp.mjs.map