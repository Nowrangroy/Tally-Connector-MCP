import http from 'node:http';
import nunjucks from 'nunjucks';
import { XMLParser } from 'fast-xml-parser';
import { utility } from './utility.mjs';
import { lstCollectionFields, lstPushXml, lstReportConfig, lstReportXml, xmlInvokeAction, xmlQueryCollection } from './definition.mjs';
const tally_host = process.env.TALLY_HOST || '13.202.32.16';
const tally_port = parseInt(process.env.TALLY_PORT || '8888'); // default gateway port
const lstPullReport = lstReportConfig;

// ── Tally Master Data Cache ───────────────────────────────────────────────────
// Caches static master collection queries (Ledger, StockItem, etc.) for
// CACHE_TTL_MS to prevent hammering Tally with repeated identical requests.
// Date-filtered or active-filter queries are NEVER cached (transactional data).
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHEABLE_COLLECTIONS = new Set(['Ledger', 'StockItem', 'Bill', 'VoucherType', 'Godown', 'Group', 'Company', 'CostCategory', 'CostCentre']);
const _queryCache = new Map(); // key -> { data, expiry }
function _cacheKey(collection, fields, filters, company) {
    return `${collection}|${company || ''}|${fields.join(',')}|${JSON.stringify(Array.from((filters || new Map()).entries()))}`;
}
export function clearTallyCache() {
    _queryCache.clear();
    console.log('[TallyCache] Cache cleared manually.');
}
// ──────────────────────────────────────────────────────────────────────────────
export const nEnv = new nunjucks.Environment();
nEnv.addFilter('formatDate', (dt, format) => {
    return utility.Date.format(dt, format);
});
nEnv.addFilter('escapeTDL', (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/"/g, '""');
});
export function renameObjectArrayProperties(source, keyMap) {
    if (!Array.isArray(source) || source.length == 0)
        return [];
    if (!(keyMap instanceof Map) || keyMap.size == 0)
        return source.map(item => item);
    return source.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return item;
        let renamed = {};
        for (const [key, value] of Object.entries(item)) {
            let targetKey = keyMap.get(key) || key;
            Object.defineProperty(renamed, targetKey, { enumerable: true, value });
        }
        return renamed;
    });
}
export async function fetchReport(targetReport, inputParams) {
    let retval = {
        data: undefined
    };
    try {
        let objReport = lstPullReport.find(p => p.name == targetReport);
        if (objReport) {
            let lstInputs = new Map();
            //set target company
            let targetCompany = '##SVCurrentCompany'; //default value
            if (inputParams.has('targetCompany') && typeof inputParams.get('targetCompany') == 'string')
                targetCompany = inputParams.get('targetCompany'); //extract from request object
            lstInputs.set('targetCompany', targetCompany); //add targetCompany as one of the params
            //populate input parameters value
            for (let i = 0; i < objReport.input.length; i++) {
                let iName = objReport.input[i].name;
                let iType = objReport.input[i].datatype;
                let _value = inputParams.get(iName);
                //check if validation is required
                if (objReport.input[i].validation_regex) {
                    let strValidationRegex = objReport.input[i].validation_regex || '';
                    let regPtrn = new RegExp(strValidationRegex, 'i');
                    if (typeof _value == 'string' && !regPtrn.test(_value)) {
                        retval.error = objReport.input[i].validation_message || `Invalid value for parameter ${iName}`;
                        return retval;
                    }
                }
                //parse the value based on type
                if (typeof _value == 'number' && iType == 'number')
                    lstInputs.set(iName, _value);
                else if (typeof _value == 'boolean' && iType == 'boolean')
                    lstInputs.set(iName, _value);
                else if (typeof _value == 'string' && iType == 'date' && /^\d\d-\d\d-\d\d\d\d$/.test(_value)) //Date in DD-MM-YYYY
                    lstInputs.set(iName, utility.Date.parse(_value, 'dd-MM-yyyy'));
                else if (typeof _value == 'string' && iType == 'date' && /^\d\d\d\d-\d\d-\d\d/.test(_value)) //ISO DateTime YYYY-MM-DDTHH:MM:SS
                    lstInputs.set(iName, utility.Date.parse(_value.substring(0, 10), 'yyyy-MM-dd'));
                else if (typeof _value == 'string' && iType == 'string')
                    lstInputs.set(iName, _value);
                else {
                    retval.error = `Parameter ${iName} not found or contains invalid value [${_value}]`;
                    return retval;
                }
            }
            // Copy optional extra parameters used by custom reports (for example partyContains in tds-payment-sheet).
            for (const [extraKey, extraValue] of inputParams.entries()) {
                if (!lstInputs.has(extraKey) && extraValue !== undefined && extraValue !== null) {
                    lstInputs.set(extraKey, extraValue);
                }
            }
            retval = await extractReport(objReport, lstInputs);
        }
        else
            retval.error = 'Invalid report';
    }
    catch (err) {
        retval.error = 'Server exception';
    }
    finally {
        return retval;
    }
}
export async function queryCollection(targetCollection, lstFields, lstFilters, targetCompany, fromDate, toDate) {
    let retval = [];

    // ── Cache lookup (master data only, no date or active filter) ────────────
    const hasActiveFilter = lstFilters && lstFilters.size > 0;
    const hasDateRange = !!(fromDate || toDate);
    const isCacheable = CACHEABLE_COLLECTIONS.has(targetCollection) && !hasActiveFilter && !hasDateRange;
    if (isCacheable) {
        const ckey = _cacheKey(targetCollection, lstFields, lstFilters, targetCompany);
        const cached = _queryCache.get(ckey);
        if (cached && Date.now() < cached.expiry) {
            return cached.data;
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    try {
        let objTemplateArgs = new Map();
        //assign static variables
        if (targetCompany)
            objTemplateArgs.set('targetCompany', targetCompany);
        if (fromDate)
            objTemplateArgs.set('fromDate', fromDate);
        if (toDate)
            objTemplateArgs.set('toDate', toDate);
        objTemplateArgs.set('collection', targetCollection);
        let objCollection = lstCollectionFields.filter(c => c.collection == targetCollection)[0]; //load collection definition
        let lstQueryFields = objCollection.fields.filter(f => lstFields.includes(f.name)); //filter fields based on user query
        objTemplateArgs.set('fields', lstQueryFields); //filter fields queried by user
        if (lstFilters && lstFilters.size > 0) {
            let objFilters = [];
            for (const [k, v] of lstFilters.entries()) {
                objFilters.push({
                    name: k,
                    expression: v
                });
            }
            objTemplateArgs.set('filters', objFilters); //add filters to template arguments
        }
        let respContent = await sendTallyXml(xmlQueryCollection, objTemplateArgs); //send XML to Tally and get response
        let xmlParser = new XMLParser({
            parseTagValue: false,
            isArray(tagName) {
                return (tagName == 'ROW' || tagName.endsWith('.LIST'));
            },
        });
        let resultObj = xmlParser.parse(respContent);
        if (resultObj['DATA'] && Array.isArray(resultObj['DATA']['ROW'])) {
            for (const rowObj of resultObj['DATA']['ROW']) {
                let o = new Object();
                for (const field of lstQueryFields) {
                    let _rawValue = rowObj[field.name] ?? rowObj[field.name.toUpperCase()];
                    let _value = (_rawValue !== undefined && _rawValue !== null ? _rawValue : '').toString();
                    let value = undefined;
                    if (field.datatype == 'boolean')
                        value = _value == 'Yes';
                    else if (field.datatype == 'number' || field.datatype == 'amount' || field.datatype == 'quantity' || field.datatype == 'rate')
                        value = parseFloat(_value);
                    else if (field.datatype == 'date')
                        value = utility.Date.parse(_value, 'yyyy-MM-dd');
                    else
                        value = utility.String.unescapeHTML(_value);
                    Object.defineProperty(o, field.name, { enumerable: true, value });
                }
                retval.push(o);
            }
        }

        // ── Store in cache if eligible ────────────────────────────────────────
        if (isCacheable && retval.length > 0) {
            const ckey = _cacheKey(targetCollection, lstFields, lstFilters, targetCompany);
            _queryCache.set(ckey, { data: retval, expiry: Date.now() + CACHE_TTL_MS });
        }
        // ─────────────────────────────────────────────────────────────────────

        return retval;
    }
    catch (err) {
        throw err;
    }
}
;
export async function invokeTallyAction(targetAction, lstParameters) {
    try {
        let objTemplateArgs = new Map();
        objTemplateArgs.set('targetReport', targetAction);
        let variables = [];
        lstParameters.forEach((v, k) => {
            variables.push({ name: k, value: v });
        });
        objTemplateArgs.set('variables', variables);
        await sendTallyXml(xmlInvokeAction, objTemplateArgs); //send XML to Tally
    }
    catch (err) {
        throw err;
    }
}
export async function importMasters(targetMaster, objMasterInput) {
    try {
        let xmlTemplate = lstPushXml.get(targetMaster) || '';
        let respContent = await sendTallyXml(xmlTemplate, objMasterInput); //send XML to Tally and get response
        const xmlParser = new XMLParser();
        let resultObj = xmlParser.parse(respContent);
        let retval = resultObj['RESPONSE'];
        return retval;
    }
    catch (err) {
        throw err;
    }
}
// ── Tally Request Semaphore ────────────────────────────────────────────────────
// Limits the number of concurrent HTTP requests to Tally to prevent overload.
// Tally ERP can only process one XML request at a time reliably; serialising
// them prevents crashes from simultaneous heavy queries.
const TALLY_MAX_CONCURRENT = 2;
let _tallyActiveRequests = 0;
const _tallyQueue = [];
function _tallyEnqueue(fn) {
    return new Promise((resolve, reject) => {
        _tallyQueue.push({ fn, resolve, reject });
        _tallyDrain();
    });
}
function _tallyDrain() {
    if (_tallyActiveRequests >= TALLY_MAX_CONCURRENT || _tallyQueue.length === 0) return;
    const { fn, resolve, reject } = _tallyQueue.shift();
    _tallyActiveRequests++;
    fn()
        .then(result => { _tallyActiveRequests--; _tallyDrain(); resolve(result); })
        .catch(err  => { _tallyActiveRequests--; _tallyDrain(); reject(err); });
}
// ──────────────────────────────────────────────────────────────────────────────

async function sendTallyXml(xml, lstVariables) {
    try {
        // remove targetCompany from lstVariables if found with default value
        if (lstVariables.has('targetCompany') && lstVariables.get('targetCompany') == '##SVCurrentCompany') {
            lstVariables.delete('targetCompany');
        }
        let o = new Object();
        // define properties for every keys in Map in object
        lstVariables.forEach((v, k) => {
            Object.defineProperty(o, k, { enumerable: true, value: v });
        });
        let xmlRequest = nEnv.renderString(xml, o);
        // Queue the actual HTTP request through the semaphore
        let xmlResponse = await _tallyEnqueue(() => postTallyXML(xmlRequest));
        return xmlResponse;
    }
    catch (err) {
        throw err;
    }
}

const xmlListCompanies = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Company</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><FETCH>Name</FETCH></DESC></BODY></ENVELOPE>';
function uniqueArray(values) {
    return [...new Set(values.filter((v) => typeof v === 'string' && v.trim().length > 0).map((v) => utility.String.unescapeHTML(v.trim())))]
}
function extractCompanyNames(xmlText) {
    const text = String(xmlText || '');
    const names = [];
    try {
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
        const parsed = parser.parse(text);
        const walk = (node, parentKey = '') => {
            if (node === undefined || node === null)
                return;
            if (Array.isArray(node)) {
                for (const item of node)
                    walk(item, parentKey);
                return;
            }
            if (typeof node !== 'object') {
                if ((parentKey === 'NAME' || parentKey === '@_NAME') && typeof node === 'string')
                    names.push(node);
                return;
            }
            if (typeof node['@_NAME'] === 'string')
                names.push(node['@_NAME']);
            if (typeof node['NAME'] === 'string')
                names.push(node['NAME']);
            if (node['NAME'] && typeof node['NAME'] === 'object' && typeof node['NAME']['#text'] === 'string')
                names.push(node['NAME']['#text']);
            for (const [key, value] of Object.entries(node))
                walk(value, key);
        };
        walk(parsed);
    }
    catch (_) { }
    // Tally Collection Company payload can return either:
    // <COMPANY NAME="ABC"><NAME>ABC</NAME></COMPANY>
    // or <NAME TYPE="String">ABC</NAME>
    const tagMatches = text.matchAll(/<NAME(?:\s+[^>]*)?>([^<]+)<\/NAME>/gi);
    for (const match of tagMatches)
        names.push(match[1]);
    const attrMatches = text.matchAll(/<COMPANY(?:\s+[^>]*)?\sNAME=["']([^"']+)["']/gi);
    for (const match of attrMatches)
        names.push(match[1]);
    return uniqueArray(names);
}
export async function discoverCompanies() {
    // When using the gateway EXE, company discovery is performed on the remote server,
    // so it can see Tally ports that are local/IPv6-only on that server.
    try {
        const response = await getGatewayJSON('/discover');
        const normalize = (rows) => rows.map((item) => {
            if (!item || typeof item !== 'object') return item;
            const company = item.company || item.name || item.companyName || (Array.isArray(item.companies) ? item.companies.join(', ') : undefined);
            return {
                company,
                host: tally_host,
                port: tally_port,
                gatewayUrl: `http://${tally_host}:${tally_port}`,
                proxyUrl: `http://${tally_host}:${tally_port}${process.env.TALLY_GATEWAY_PROXY_PATH || '/proxy'}`,
                internalPort: item.port || item.internalPort,
                internalHost: item.host || item.internalHost,
                ok: item.ok !== false,
                status: item.status || (item.ok === false ? 'inactive' : 'active')
            };
        });
        if (Array.isArray(response))
            return normalize(response);
        if (response && Array.isArray(response.companies))
            return normalize(response.companies);
        return response;
    }
    catch (err) {
        // Fallback for direct Tally mode: test configured ports only.
        const rawPorts = process.env.TALLY_DISCOVERY_PORTS || process.env.TALLY_PORTS || String(tally_port);
        const ports = uniqueArray(rawPorts.split(',')).map((p) => parseInt(p, 10)).filter((p) => Number.isFinite(p) && p > 0 && p < 65536);
        const results = [];
        for (const port of ports.length ? ports : [tally_port]) {
            try {
                const response = await postDirectTallyXML(xmlListCompanies, { port });
                results.push({ host: tally_host, port, ok: true, companies: extractCompanyNames(response), source: 'direct-fallback' });
            }
            catch (directErr) {
                const message = typeof directErr === 'string' ? directErr : (directErr?.message || directErr?.code || JSON.stringify(directErr));
                results.push({ host: tally_host, port, ok: false, error: message, companies: [], source: 'direct-fallback' });
            }
        }
        return results;
    }
}

async function getGatewayJSON(path) {
    return new Promise((resolve, reject) => {
        try {
            const req = http.request({
                hostname: tally_host,
                port: tally_port,
                path,
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                },
                timeout: parseInt(process.env.TALLY_TIMEOUT_MS || '15000', 10)
            }, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => data += chunk.toString());
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400)
                        return reject(new Error(`Gateway returned HTTP ${res.statusCode}: ${data}`));
                    try {
                        resolve(JSON.parse(data || 'null'));
                    }
                    catch (parseErr) {
                        reject(new Error(`Gateway returned non-JSON response: ${String(data).slice(0, 300)}`));
                    }
                });
                res.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('Gateway request timed out')));
            req.on('error', reject);
            req.end();
        }
        catch (err) {
            reject(err);
        }
    });
}

function extractCurrentCompanyFromXml(xml) {
    const text = String(xml || '');
    const m = text.match(/<SVCURRENTCOMPANY(?:\s+[^>]*)?>([\s\S]*?)<\/SVCURRENTCOMPANY>/i);
    if (!m) return '';
    return utility.String.unescapeHTML(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
}

export async function postTallyXML(xml, options = {}) {
    // Gateway mode: every MCP tool sends the exact XML to the remote gateway /proxy.
    // The gateway then routes locally to the correct Tally port/company.
    return new Promise((resolve, reject) => {
        try {
            const targetCompany = options.targetCompany || extractCurrentCompanyFromXml(xml);
            const xmlBuffer = Buffer.from(xml, 'utf8');
            const headers = {
                'Content-Length': xmlBuffer.length,
                'Content-Type': 'text/xml; charset=utf-8'
            };
            // Do not URL-encode this header. Gateway matches the exact company name from /discover.
            if (targetCompany)
                headers['x-tally-company'] = targetCompany;
            const req = http.request({
                hostname: tally_host,
                port: options.port || tally_port,
                path: process.env.TALLY_GATEWAY_PROXY_PATH || '/proxy',
                method: 'POST',
                headers,
                timeout: parseInt(process.env.TALLY_TIMEOUT_MS || '60000', 10)
            }, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => data += chunk.toString() || '');
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400)
                        return reject(new Error(`Gateway returned HTTP ${res.statusCode}: ${data}`));
                    resolve(data);
                });
                res.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('Tally gateway request timed out')));
            req.on('error', (reqError) => {
                let errorType = reqError['message'] || reqError['code'];
                if (errorType === 'ECONNREFUSED')
                    reject('Unable to connect to Tally gateway. Ensure tally-gateway.exe is running on port ' + (options.port || tally_port) + ' and AWS/Windows Firewall allows this port.');
                else
                    reject(reqError);
            });
            req.write(xmlBuffer);
            req.end();
        }
        catch (err) {
            reject(err);
        }
    });
}

async function postDirectTallyXML(xml, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            let req = http.request({
                hostname: tally_host,
                port: options.port || tally_port,
                path: '',
                method: 'POST',
                headers: {
                    'Content-Length': Buffer.byteLength(xml, 'utf16le'),
                    'Content-Type': 'text/xml;charset=utf-16'
                }
            }, (res) => {
                let data = '';
                res
                    .setEncoding('utf16le')
                    .on('data', (chunk) => {
                    let result = chunk.toString() || '';
                    data += result;
                })
                    .on('end', () => {
                    resolve(data);
                })
                    .on('error', (httpErr) => {
                    reject(httpErr);
                });
            });
            req.on('error', (reqError) => {
                let errorType = reqError['message'] || reqError['code'];
                if (errorType === 'ECONNREFUSED')
                    reject('Unable to connect to Tally. Ensure Tally is running and XML server is enabled on port ' + (options.port || tally_port) + ' by going to Help (F1) > Settings > Connectivity in Tally and setting Client / Server configuration, set Tally Prime is action as Server');
                else
                    reject(reqError);
            });
            req.write(xml, 'utf16le');
            req.end();
        }
        catch (err) {
            reject(err);
        }
    });
}
function extractReport(reportConfig, reportInputParams) {
    return new Promise(async (resolve, reject) => {
        let retval = {
            data: undefined
        };
        try {
            let parseString = (iStr) => {
                iStr = utility.String.unescapeHTML(iStr);
                iStr = iStr.replace(/&#\d+;/g, ''); //remove unreadable characters;
                return iStr;
            };
            let parseDate = (iDate) => {
                if (/^\d\d\d\d-\d\d-\d\d$/.test(iDate))
                    return utility.Date.parse(iDate, 'yyyy-MM-dd');
                else if (/^\d?\d-\w\w\w-\d\d\d\d$/.test(iDate))
                    return utility.Date.parse(iDate, 'd-MMM-yyyy');
                else if (/^\d?\d-\w\w\w-\d\d$/.test(iDate)) {
                    return utility.Date.parse(iDate, 'd-MMM-yy');
                }
                else
                    return null;
            };
            const parseQuantity = (iStr) => {
                let regPatOutput = /^(-?\d+\.\d+|-?\d+)\s.+/g.exec(iStr);
                if (regPatOutput && typeof regPatOutput[1] == 'string' && !isNaN(parseFloat(regPatOutput[1])))
                    return parseFloat(regPatOutput[1]);
                else
                    return 0;
            };
            const parseNumber = (iNum) => {
                if (!iNum)
                    return 0;
                else
                    return parseFloat(iNum.replace(/[\(\),]+/g, ''));
            };
            const processRows = (targetObjRows, targetConfigFields) => {
                let data = [];
                let rowCount = targetObjRows.length;
                //loop through rows
                for (let r = 0; r < rowCount; r++) {
                    let o = new Object();
                    //loop through each field and extract value
                    for (const prop of targetConfigFields) {
                        let tagName = prop.name; // match XMLTAG case exactly (report fields use lowercase tags e.g. 'date', 'amount')
                    let tagNameUpper = prop.name.toUpperCase(); // fallback for collection queries that use uppercase tags
                        let datatype = prop.datatype;
                        let fieldName = prop.name;
                        let value = undefined;
                        let _value = targetObjRows[r][tagName] ?? targetObjRows[r][tagNameUpper];
                        if (_value !== undefined) {
                            if (datatype == 'number')
                                value = parseNumber(_value);
                            else if (datatype == 'date')
                                value = parseDate(_value);
                            else if (datatype == 'boolean')
                                value = _value == '1';
                            else if (datatype == 'quantity')
                                value = parseQuantity(_value);
                            else if (datatype == 'array' || Array.isArray(_value) || typeof _value === 'object')
                                value = _value;
                            else
                                value = parseString(_value);
                        }
                        Object.defineProperty(o, fieldName, { enumerable: true, value });
                    }
                    //add row to array
                    data.push(o);
                }
                return data;
            };
            let tmplXML = lstReportXml.get(reportConfig.name) || '';
            let respContent = await sendTallyXml(tmplXML, reportInputParams);
            if (!respContent) {
                retval.error = 'Empty data received from Tally';
                return;
            }
            else if (respContent.startsWith('<EXCEPTION>')) {
                let regErr = respContent.match(/<EXCEPTION>(.+)<\/EXCEPTION>/g);
                let errorMessage = 'Unknown error';
                if (regErr && regErr[0])
                    errorMessage = regErr[0].substring(11, regErr[0].length - 12);
                retval.error = errorMessage;
                return;
            }
            let xmlParser = new XMLParser({
                parseTagValue: false,
                isArray(tagName) {
                    return (tagName == 'ROW' || tagName.endsWith('.LIST'));
                },
            });
            let resultObj = xmlParser.parse(respContent);
            const rows = resultObj && resultObj['DATA'] && Array.isArray(resultObj['DATA']['ROW']) ? resultObj['DATA']['ROW'] : [];
            let data = processRows(rows, reportConfig.output);
            retval.data = data;
        }
        catch (err) {
            throw err;
        }
        finally {
            resolve(retval);
        }
    });
}
//# sourceMappingURL=tally.mjs.map