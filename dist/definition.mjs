/**
 * JSON objects of report XML definitions and configurations
 */
export const lstOptionCountryState = [
    {
        country: 'India',
        state: ['Andaman & Nicobar', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh', 'Dadra & Nagar Haveli and Daman & Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu & Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal']
    },
    {
        country: 'UAE',
        state: ['Abu Dhabi', 'Ajman', 'Dubai', 'Fujairah', 'Ras al-Khaimah', 'Sharjah', 'Umm al-Quwain']
    },
    {
        country: 'UK',
        state: ['England', 'Scotland', 'Wales', 'Northern Ireland']
    },
    {
        country: 'USA',
        states: ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming']
    },
    {
        country: 'Saudi Arabia',
        states: ['Riyadh', 'Makkah', 'Madina', 'Eastern Province', 'Asir', 'Tabuk', 'Hail', 'Northern Borders', 'Jizan', 'Najran', 'Al-Baha', 'Al-Jouf']
    },
    {
        country: 'Qatar',
        states: ['Doha', 'Al Rayyan', 'Al Wakrah', 'Al Khor', 'Al Shamal', 'Al Daayen', 'Umm Salal', 'Ash Shihaniyah']
    },
    {
        country: 'Kuwait',
        states: ['Al Asimah', 'Hawalli', 'Al Ahmadi', 'Al Farwaniyah', 'Al Jahra']
    },
    {
        country: 'Tanzania',
        states: ['Arusha', 'Dar es Salaam', 'Dodoma', 'Geita', 'Iringa', 'Kagera', 'Katavi', 'Kigoma', 'Kilimanjaro', 'Lindi', 'Manyara', 'Mara', 'Mbeya', 'Morogoro', 'Mtwara', 'Mwanza', 'Njombe', 'Pemba North', 'Pemba South', 'Pwani', 'Rukwa', 'Ruvuma', 'Shinyanga', 'Simiyu', 'Singida', 'Tabora', 'Tanga']
    },
    {
        country: 'Nigeria',
        states: ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara']
    }
];
export const lstCollections = ['Company', 'Group', 'Ledger', 'VoucherType', 'Unit', 'Godown', 'StockGroup', 'StockItem', 'CostCategory', 'CostCentre', 'Voucher'];
export const lstCollectionFields = [
    {
        collection: 'Company',
        fields: [
            { name: 'Name', datatype: 'string' },
            { name: 'Address', datatype: 'string', expression: 'if $$IsEmpty:$Address then "" else $$FullList:Address:$Address' },
            { name: 'StateName', datatype: 'string' },
            { name: 'CountryName', datatype: 'string' },
            { name: 'Pincode', datatype: 'string', description: 'postal code or ZIP code of the company' },
            { name: 'PhoneNumber', datatype: 'string', description: 'contact or mobile number' },
            { name: 'Email', datatype: 'string' },
            { name: 'BooksFrom', datatype: 'date', description: 'financial year start date when the books keeping started or the company was split' },
            { name: 'IsActiveCompany', datatype: 'boolean', expression: '$$IsEqual:$Name:##SVCurrentCompany', description: 'true if the company is active and currently selected in Tally, false if the company is inactive or not currently selected in Tally' }
        ]
    },
    {
        collection: 'VoucherType',
        fields: [
            { name: 'Name', datatype: 'string' },
            { name: 'Parent', datatype: 'string' },
            { name: 'AffectsStock', datatype: 'boolean' },
        ]
    },
    {
        collection: 'Group',
        fields: [
            { name: 'Name', datatype: 'string' },
            { name: 'Parent', datatype: 'string', expression: 'if $$IsEqual:$Parent:$$SysName:Primary then "" else $Parent' },
            { name: 'IsRevenue', datatype: 'boolean', description: 'true if the group belongs to profit loss, false if group belongs to balance sheet' },
            { name: 'IsDeemedPositive', datatype: 'boolean', description: 'true if group nature is debit, false if group nature is credit' },
            { name: 'AffectsGrossProfit', datatype: 'boolean', description: 'applicable only when isRevenue is true, if found true then group belongs to trading used for gross profit calculation' },
            { name: 'SortPosition', datatype: 'number' },
            { name: 'OpeningBalance', datatype: 'amount', description: 'opening or starting or begning balance of group based on from date' },
            { name: 'ClosingBalance', datatype: 'amount', description: 'closing or ending balance of group based on to date' }
        ]
    },
    {
        collection: 'Ledger',
        fields: [
            { name: 'Name', datatype: 'string' },
            { name: 'Parent', datatype: 'string', expression: 'if $$IsEqual:$Parent:$$SysName:Primary then "Reserves & Surplus" else $Parent', description: 'group under which ledger is nested' },
            { name: '_PrimaryGroup', datatype: 'string', description: 'primary group of parent or group, under which ledger is nested' },
            { name: 'IsRevenue', datatype: 'boolean', description: 'true if the group belongs to profit loss, false if group belongs to balance sheet' },
            { name: 'IsDeemedPositive', datatype: 'boolean', description: 'true if group nature is debit, false if group nature is credit' },
            { name: 'AffectsGrossProfit', datatype: 'boolean', description: 'applicable only when isRevenue is true, if found true then group belongs to trading used for gross profit calculation' },
            { name: 'OpeningBalance', datatype: 'amount', description: 'opening or starting or begning balance based on from date' },
            { name: 'ClosingBalance', datatype: 'amount', description: 'closing or ending or balance based on to date' },
            { name: 'DebitTotals', datatype: 'amount', description: 'total debit amount of all vouchers passed during the period from and to date, negative denotes debit and vice-a-versa' },
            { name: 'CreditTotals', datatype: 'amount', description: 'total credit amount of all vouchers passed during the period from and to date, positive denotes credit and vice-a-versa' },
            { name: 'BankAccountNo', datatype: 'string', expression: 'if $$IsEmpty:$BankAccountNo then "" else $BankAccountNo' },
            { name: 'IFSCCode', datatype: 'string', expression: 'if $$IsEmpty:$IFSCCode then "" else $IFSCCode' },
            { name: 'BankName', datatype: 'string', expression: 'if $$IsEmpty:$BankName then "" else $BankName' }
        ]
    },
    {
        collection: 'Unit',
        description: 'Unit of measurement used for stock items',
        fields: [
            { name: 'Name', datatype: 'string' },
            { name: 'Parent', datatype: 'string' },
            { name: 'FormalName', datatype: 'string', description: 'full name or formal name like Kilogram for name as kg, Litre for name as ltr, Piece for name as pcs' },
            { name: 'BaseUnits', datatype: 'string', description: 'base units' },
            { name: 'AdditionalUnits', datatype: 'string', description: 'additional units if any' },
            { name: 'Conversion', datatype: 'string', description: 'conversion expression or multiplier to convert additional units to base units if applicable, example "1 Dozen = 12 Pcs" or "1 Quintal = 100 Kgs"' }
        ]
    },
    {
        collection: 'Godown',
        description: 'warehouse or location of stock items',
        fields: [
            { name: 'Name', datatype: 'string' },
            { name: 'Parent', datatype: 'string' },
            { name: 'Address', datatype: 'string', expression: 'if $$IsEmpty:$Address then "" else $$FullList:Address:$Address' },
        ]
    },
    {
        collection: 'StockGroup',
        description: 'group of stock item',
        fields: [
            { name: 'Name', datatype: 'string' },
            { name: 'Parent', datatype: 'string', expression: 'if $$IsEqual:$Parent:$$SysName:Primary then "" else $Parent' }
        ]
    },
    {
        collection: 'StockCategory',
        description: 'category of stock item',
        fields: [
            { name: 'Name', datatype: 'string' },
            { name: 'Parent', datatype: 'string', expression: 'if $$IsEqual:$Parent:$$SysName:Primary then "" else $Parent' }
        ]
    },
    {
        collection: 'StockItem',
        description: 'stock item or product or service constituting inventory or services purchased or sold',
        fields: [
            { name: 'Name', datatype: 'string' },
            { name: 'Parent', datatype: 'string', expression: 'if $$IsEqual:$Parent:$$SysName:Primary then "" else $Parent', description: 'name field of StockGroup collection under which item is nested' },
            { name: 'Category', datatype: 'string', description: 'name field of StockCategory collection under which item is nested if applicable' },
            { name: 'OnlyAlias', datatype: 'string', description: 'alternate name or alias' },
            { name: 'BaseUnits', datatype: 'string' },
            { name: 'PartNo', datatype: 'string', expression: 'if $$IsEqual:$BaseUnits:$$SysName:NotApplicable then "" else $BaseUnits', description: 'part number, or classification' },
            { name: 'Unit', datatype: 'string', expression: 'if $$IsEqual:$BaseUnits:$$SysName:NotApplicable then "" else $BaseUnits', description: 'name field of Unit collection under which item is nested' },
            { name: 'AlternateUnit', datatype: 'string', expression: 'if $$IsEqual:$AdditionalUnits:$$SysName:NotApplicable then "" else $AdditionalUnits', description: 'name field of Unit collection under which item is nested which is set as alternate or additional unit' },
            { name: 'Conversion', datatype: 'number', description: 'multiplier for alternate or additional unit' },
            { name: 'OpeningBalance', datatype: 'quantity', description: 'opening or begning quantity as on from date' },
            { name: 'ClosingBalance', datatype: 'quantity', description: 'closing or ending or balance quantity left as on to date' },
            { name: 'OpeningValue', datatype: 'amount', description: 'opening or begning value of stock item as on from date, negative denotes debit and to be treated as positive and vice-a-versa' },
            { name: 'ClosingValue', datatype: 'amount', description: 'closing or ending value of stock item as on to date, negative denotes debit and to be treated as positive and vice-a-versa' },
            { name: 'OpeningRate', datatype: 'rate', description: 'opening or begning rate as on from date' },
            { name: 'ClosingRate', datatype: 'rate', description: 'closing or ending rate as on to date' },
            { name: 'CostingMethod', datatype: 'string', description: 'method of valuation of opening or closing stock which can be Avg. Cost (Average Cost), FIFO (First in First Out), Std. Cost (Standard Cost), At Zero Cost, Monthly Avg. Cost' },
            { name: 'InwardQuantity', datatype: 'quantity', description: 'total inward quantity purchase or sales return or stock transfer during the period from and to date' },
            { name: 'OutwardQuantity', datatype: 'quantity', description: 'total outward quantity sales or purchase return or stock transfer during the period from and to date, it will be in negative which denotes outflow to be treated as positive and vice-a-versa' },
            { name: 'InwardValue', datatype: 'amount', description: 'total inward value of purchase or sales return or stock transfer during the period from and to date, negative denotes debit and positive credit' },
            { name: 'OutwardValue', datatype: 'amount', description: 'total outward value of sales or purchase return or stock transfer during the period from and to date, positive denotes credit and negative debit' },
        ]
    },
    {
        collection: 'Bill',
        description: 'Bill references for outstanding payables or receivables',
        fields: [
            { name: 'BillDate', datatype: 'date' },
            { name: 'Name', datatype: 'string', description: 'bill number or reference number' },
            { name: 'ClosingBalance', datatype: 'amount', description: 'closing or outstanding balance of bill as on to date, negative denotes debit and positive credit' },
            { name: 'Parent', datatype: 'string', description: 'name field of Ledger collection, party debtor or creditor under which bill is nested' },
            { name: '_OverDueDays', datatype: 'number', description: 'over due days, number of days bill is overdue as on to date' }
        ]
    }
];
// minified XML of ./template/generic/query-collection.njk
export const xmlQueryCollection = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyTallyLiveReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>{% if fromDate %}<SVFROMDATE>{{ fromDate | formatDate("d-MMM-yyyy") }}</SVFROMDATE>{% endif %}{% if toDate %}<SVTODATE>{{ toDate | formatDate("d-MMM-yyyy") }}</SVTODATE>{% endif %}{% if targetCompany %}<SVCURRENTCOMPANY>{{ targetCompany | escape }}</SVCURRENTCOMPANY>{% endif %}</STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyTallyLiveReport"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart01</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MyPart01"><LINES>MyLine01</LINES><REPEAT>MyLine01 : MyCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART><LINE NAME="MyLine01"><FIELDS>{% set comma = joiner() %}{% for field in fields -%}{{ comma() }}fld_{{ field.name }}{%- endfor %}</FIELDS><XMLTAG>ROW</XMLTAG></LINE>{% for field in fields %}<FIELD NAME="fld_{{ field.name }}">{% if field.expression %}<SET>{{ field.expression }}</SET>{% elif field.datatype == "date" %}<SET>if $$IsEmpty:${{ field.name }} then "" else $$PyrlYYYYMMDDFormat:${{ field.name }}:"-"</SET>{% elif field.datatype == "boolean" %}<SET>if ${{ field.name }} then 1 else 0</SET>{% elif field.datatype == "amount" %}<SET>$$StringFindAndReplace:(if $$IsDebit:${{ field.name }} then -$$NumValue:${{ field.name }} else $$NumValue:${{ field.name }}):"(-)":"-"</SET>{% elif field.datatype == "number" %}<SET>if $$IsEmpty:${{ field.name }} then 0 else $$StringFindAndReplace:($$String:${{ field.name }}):"(-)":"-"</SET>{% elif field.datatype == "quantity" %}<SET>$$StringFindAndReplace:(if $$IsInwards:${{ field.name }} then $$Number:$$String:${{ field.name }}"TailUnits" else -$$Number:$$String:${{ field.name }}:"TailUnits"):"(-)":"-"</SET>{% elif field.datatype == "rate" %}<SET>if $$IsEmpty:${{ field.name }} then 0 else $$Number:${{ field.name }}</SET>{% else %}<SET>${{ field.name }}</SET>{% endif %}<XMLTAG>{{ field.name }}</XMLTAG></FIELD>{% endfor %}<COLLECTION NAME="MyCollection"><TYPE>{{ collection }}</TYPE>{% if filters.length %}<FILTER>{% set comma = joiner() %}{% for filter in filters -%}{{ comma() }}fltr_{{ filter.name }}{%- endfor %}</FILTER>{% endif %}<FETCH>{% set comma = joiner() %}{% for field in fields -%}{{ comma() }}fld_{{ field.name }}{%- endfor %}</FETCH></COLLECTION>{% for filter in filters %}<SYSTEM TYPE="Formulae" NAME="fltr_{{ filter.name }}">{{ filter.expression }}</SYSTEM>{% endfor %}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
// minified XML of ./template/generic/invoke-action.njk
export const xmlInvokeAction = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyTallyLiveReport</ID></HEADER><BODY><DESC><TDL><TDLMESSAGE><REPORT NAME="MyTallyLiveReport"><USE>{{ targetReport }}</USE>{% for variable in variables %}<SET>{{ variable.name }} : "{{ variable.value | escape }}"</SET>{% endfor %}</REPORT></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
// minified XML of ./template/report/*.njk
export const lstReportXml = new Map([
    ['ledger-account', '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyTallyLiveReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>{{ fromDate | formatDate("d-MMM-yyyy") }}</SVFROMDATE><SVTODATE>{{ toDate | formatDate("d-MMM-yyyy") }}</SVTODATE>{% if targetCompany %}<SVCURRENTCOMPANY>{{ targetCompany | escape }}</SVCURRENTCOMPANY>{% endif %}</STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyTallyLiveReport"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart01</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MyPart01"><LINES>MyLine01,MyLineOp</LINES><REPEAT>MyLine01 : MyCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART><LINE NAME="MyLine01"><FIELDS>FldGuid,FldDate,FldVoucherType,FldVoucherNumber,FldAlternateLedger,FldPartyLedger,FldAmount,FldNarration</FIELDS><XMLTAG>ROW</XMLTAG></LINE><LINE NAME="MyLineOp"><FIELDS>FldDateOp,FldVoucherTypeOp,FldAmountOp</FIELDS><XMLTAG>ROW</XMLTAG></LINE><FIELD NAME="FldGuid"><SET>$Guid</SET><XMLTAG>guid</XMLTAG></FIELD><FIELD NAME="FldDate"><SET>$Date</SET><XMLTAG>date</XMLTAG></FIELD><FIELD NAME="FldVoucherType"><SET>$VoucherTypeName</SET><XMLTAG>voucher_type</XMLTAG></FIELD><FIELD NAME="FldVoucherNumber"><SET>$VoucherNumber</SET><XMLTAG>voucher_number</XMLTAG></FIELD><FIELD NAME="FldAlternateLedger"><SET>$AllLedgerEntries[1,@@FilterNotLedgerEqual].LedgerName</SET><XMLTAG>alternate_ledger</XMLTAG></FIELD><FIELD NAME="FldPartyLedger"><SET>$PartyLedgerName</SET><XMLTAG>party_ledger</XMLTAG></FIELD><FIELD NAME="FldAmount"><SET>if $$IsDebit:($AllLedgerEntries[1,@@FilterLedgerEqual].Amount) then -$$NumValue:$AllLedgerEntries[1,@@FilterLedgerEqual].Amount else $$NumValue:$AllLedgerEntries[1,@@FilterLedgerEqual].Amount</SET><XMLTAG>amount</XMLTAG></FIELD><FIELD NAME="FldNarration"><SET>$Narration</SET><XMLTAG>narration</XMLTAG></FIELD><FIELD NAME="FldDateOp"><SET>##SVFromDate</SET><XMLTAG>date</XMLTAG></FIELD><FIELD NAME="FldVoucherTypeOp"><SET>"Opening"</SET><XMLTAG>voucher_type</XMLTAG></FIELD><FIELD NAME="FldAmountOp"><SET>if $$IsDebit:$OpeningBalance:Ledger:"{{ ledgerName | escapeTDL }}" then -$$NumValue:$OpeningBalance:Ledger:"{{ ledgerName | escapeTDL }}" else $$NumValue:$OpeningBalance:Ledger:"{{ ledgerName | escapeTDL }}"</SET><XMLTAG>amount</XMLTAG></FIELD><COLLECTION NAME="MyCollection"><TYPE>Voucher</TYPE><FETCH>AllLedgerEntries,Narration,PartyLedgerName</FETCH><FILTER>FilterLedger,FilterExcludeOrderVch,FilterCancelledVouchers,FilterOptionalVouchers</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="FilterLedger">NOT $$IsEmpty:$AllLedgerEntries[1,@@FilterLedgerEqual].LedgerName</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterLedgerEqual">$$IsEqual:$LedgerName:"{{ ledgerName | escapeTDL }}"</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterNotLedgerEqual">NOT $$IsEqual:$LedgerName:"{{ ledgerName | escapeTDL }}"</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterExcludeOrderVch">NOT $$IsOrderVch:$VoucherTypeName</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterCancelledVouchers">NOT $IsCancelled</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterOptionalVouchers">NOT $IsOptional</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'],
    ['stock-item-account', '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyTallyLiveReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>{{ fromDate | formatDate("d-MMM-yyyy") }}</SVFROMDATE><SVTODATE>{{ toDate | formatDate("d-MMM-yyyy") }}</SVTODATE>{% if targetCompany %}<SVCURRENTCOMPANY>{{ targetCompany | escape }}</SVCURRENTCOMPANY>{% endif %}</STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyTallyLiveReport"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart01</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MyPart01"><LINES>MyLine01,MyLineOp</LINES><REPEAT>MyLine01 : MyCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART><LINE NAME="MyLine01"><FIELDS>FldDate,FldVoucherType,FldVoucherNumber,FldPartyLedger,FldQuantity,FldAmount,FldNarration,FldTrackingNumber,FldVoucherTypeParent</FIELDS><XMLTAG>ROW</XMLTAG></LINE><LINE NAME="MyLineOp"><FIELDS>FldDateOp,FldVoucherTypeOp,FldQuantityOp,FldAmountOp,FldVoucherTypeParentOp</FIELDS><XMLTAG>ROW</XMLTAG></LINE><FIELD NAME="FldDate"><SET>$Date</SET><XMLTAG>date</XMLTAG></FIELD><FIELD NAME="FldVoucherType"><SET>$VoucherTypeName</SET><XMLTAG>voucher_type</XMLTAG></FIELD><FIELD NAME="FldVoucherNumber"><SET>$VoucherNumber</SET><XMLTAG>voucher_number</XMLTAG></FIELD><FIELD NAME="FldPartyLedger"><SET>$PartyLedgerName</SET><XMLTAG>party_ledger</XMLTAG></FIELD><FIELD NAME="FldQuantity"><SET>if $$IsInwards:$AllInventoryEntries[1,@@FilterItemEqual].BilledQty then $$Number:$AllInventoryEntries[1,@@FilterItemEqual].BilledQty else -$$Number:$AllInventoryEntries[1,@@FilterItemEqual].BilledQty</SET><XMLTAG>quantity</XMLTAG></FIELD><FIELD NAME="FldAmount"><SET>if $$IsDebit:($AllInventoryEntries[1,@@FilterItemEqual].Amount) then -$$NumValue:$AllInventoryEntries[1,@@FilterItemEqual].Amount else $$NumValue:$AllInventoryEntries[1,@@FilterItemEqual].Amount</SET><XMLTAG>amount</XMLTAG></FIELD><FIELD NAME="FldNarration"><SET>$Narration</SET><XMLTAG>narration</XMLTAG></FIELD><FIELD NAME="FldTrackingNumber"><SET>if ($$IsEmpty:$AllInventoryEntries[1,@@FilterItemEqual].TrackingNumber or $$IsNotApplicable:$AllInventoryEntries[1,@@FilterItemEqual].TrackingNumber) then "" else $AllInventoryEntries[1,@@FilterItemEqual].TrackingNumber</SET><XMLTAG>tracking_number</XMLTAG></FIELD><FIELD NAME="FldVoucherTypeParent"><SET>$Parent:VoucherType:$VoucherTypeName</SET><XMLTAG>voucher_category</XMLTAG></FIELD><FIELD NAME="FldDateOp"><SET>##SVFromDate</SET><XMLTAG>date</XMLTAG></FIELD><FIELD NAME="FldVoucherTypeOp"><SET>"Opening"</SET><XMLTAG>voucher_type</XMLTAG></FIELD><FIELD NAME="FldQuantityOp"><SET>if $$IsInwards:$OpeningBalance:StockItem:"{{ itemName | escapeTDL }}" then $$NumValue:$OpeningBalance:StockItem:"{{ itemName | escapeTDL }}" else -$$NumValue:$OpeningBalance:StockItem:"{{ itemName | escapeTDL }}"</SET><XMLTAG>quantity</XMLTAG></FIELD><FIELD NAME="FldAmountOp"><SET>if $$IsDebit:$OpeningValue:StockItem:"{{ itemName | escapeTDL }}" then -$$NumValue:$OpeningValue:StockItem:"{{ itemName | escapeTDL }}" else $$NumValue:$OpeningValue:StockItem:"{{ itemName | escapeTDL }}"</SET><XMLTAG>amount</XMLTAG></FIELD><FIELD NAME="FldVoucherTypeParentOp"><SET>"Opening"</SET><XMLTAG>voucher_category</XMLTAG></FIELD><COLLECTION NAME="MyCollection"><TYPE>Voucher</TYPE><FETCH>AllInventoryEntries,Narration,PartyLedgerName</FETCH><FILTER>FilterStockItem,FilterExcludeOrderVch,FilterCancelledVouchers,FilterOptionalVouchers</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="FilterStockItem">NOT $$IsEmpty:$AllInventoryEntries[1,@@FilterItemEqual].StockItemName</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterItemEqual">$$IsEqual:$StockItemName:"{{ itemName | escapeTDL }}"</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterInventoryVch">$$IsInventoryVch:$VoucherTypeName</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterExcludeOrderVch">NOT $$IsOrderVch:$VoucherTypeName</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterCancelledVouchers">NOT $IsCancelled</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterOptionalVouchers">NOT $IsOptional</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'],
]);
// minified XML of ./template/push/*.njk
export const lstPushXml = new Map([
    ['master-ledger', '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES>{% if targetCompany %}<SVCURRENTCOMPANY>{{targetCompany | escape}}</SVCURRENTCOMPANY>{% endif %}</STATICVARIABLES></REQUESTDESC><REQUESTDATA>{% for master in masters %}<TALLYMESSAGE><LEDGER NAME="{{ master._name or master.name | escape }}" ACTION="Create"><LANGUAGENAME.LIST><NAME.LIST><NAME>{{ master.name | escape }}</NAME></NAME.LIST></LANGUAGENAME.LIST>{% if master.parent %}<PARENT>{{ master.parent | escape }}</PARENT>{% endif %}{% if master.openingBalance != undefined %}<OPENINGBALANCE>{{ master.openingBalance }}</OPENINGBALANCE>{% endif %}{% if master.isBillWise != undefined %}<ISBILLWISEON>{{"Yes" if master.isBillWise else "No" }}</ISBILLWISEON>{% if master.billCreditPeriod != undefined %}<BILLCREDITPERIOD>{{ master.billCreditPeriod }} Days</BILLCREDITPERIOD>{% endif %}{% endif %}{% if master.mailingDetails %}<LEDMAILINGDETAILS.LIST><APPLICABLEFROM>{{ master.mailingDetails.applicableFrom | formatDate("yyyyMMdd") }}</APPLICABLEFROM>{% if master.mailingDetails.name != undefined %}<MAILINGNAME>{{ master.mailingDetails.name | escape }}</MAILINGNAME>{% endif %}<COUNTRY>{{ master.mailingDetails.country | escape }}</COUNTRY><STATE>{{ master.mailingDetails.state | escape }}</STATE>{% if master.mailingDetails.pincode != undefined %}<PINCODE>{{ master.mailingDetails.pincode | escape }}</PINCODE>{% endif %}</LEDMAILINGDETAILS.LIST>{% if master.gstRegistrationDetails %}<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>{{ master.gstRegistrationDetails.applicableFrom | formatDate("yyyyMMdd") }}</APPLICABLEFROM><GSTREGISTRATIONTYPE>{{ master.gstRegistrationDetails.registrationType | escape }}</GSTREGISTRATIONTYPE>{% if master.gstRegistrationDetails.placeOfSupply != undefined %}<PLACEOFSUPPLY>{{ master.gstRegistrationDetails.placeOfSupply | escape }}</PLACEOFSUPPLY>{% endif %}<GSTIN>{{ master.gstRegistrationDetails.gstin | escape }}</GSTIN></LEDGSTREGDETAILS.LIST>{% endif %}{% endif %}</LEDGER></TALLYMESSAGE>{% endfor %}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>']
]);
export const lstReportConfig = [
    {
        name: 'ledger-account',
        input: [
            { name: 'fromDate', datatype: 'date' },
            { name: 'toDate', datatype: 'date' },
            { name: 'ledgerName', datatype: 'string' }
        ],
        output: [
            { name: 'guid', datatype: 'string' },
            { name: 'date', datatype: 'date' },
            { name: 'voucher_type', datatype: 'string' },
            { name: 'voucher_number', datatype: 'string' },
            { name: 'alternate_ledger', datatype: 'string' },
            { name: 'party_ledger', datatype: 'string' },
            { name: 'amount', datatype: 'number' },
            { name: 'narration', datatype: 'string' }
        ]
    },
    {
        name: 'stock-item-account',
        input: [
            { name: 'fromDate', datatype: 'date' },
            { name: 'toDate', datatype: 'date' },
            { name: 'itemName', datatype: 'string' }
        ],
        output: [
            { name: 'date', datatype: 'date' },
            { name: 'voucher_type', datatype: 'string' },
            { name: 'voucher_number', datatype: 'string' },
            { name: 'party_ledger', datatype: 'string' },
            { name: 'quantity', datatype: 'number' },
            { name: 'amount', datatype: 'number' },
            { name: 'narration', datatype: 'string' },
            { name: 'tracking_number', datatype: 'string' },
            { name: 'voucher_category', datatype: 'string' }
        ]
    }
];
//# sourceMappingURL=definition.mjs.map
// Runtime compatibility additions for TDS/PAN workflows.
// These are appended so the bundled MCP can read PAN/GSTIN from Ledger master and build TDS rows without reverse-calculating taxable value.
{
  const ledgerDef = lstCollectionFields.find(c => c.collection === 'Ledger');
  if (ledgerDef) {
    const addField = (field) => { if (!ledgerDef.fields.some(f => f.name === field.name)) ledgerDef.fields.push(field); };
    addField({ name: 'IncomeTaxNumber', datatype: 'string', expression: 'if $$IsEmpty:$IncomeTaxNumber then "" else $IncomeTaxNumber', description: 'PAN / income tax number stored on ledger master' });
    addField({ name: 'PANITNo', datatype: 'string', expression: 'if $$IsEmpty:$PANITNo then "" else $PANITNo', description: 'alternate PAN field from ledger master' });
    addField({ name: 'PANNo', datatype: 'string', expression: 'if $$IsEmpty:$PANNo then "" else $PANNo', description: 'alternate PAN field from ledger master' });
    addField({ name: 'PAN', datatype: 'string', expression: 'if NOT $$IsEmpty:$IncomeTaxNumber then $IncomeTaxNumber else if NOT $$IsEmpty:$PANITNo then $PANITNo else if NOT $$IsEmpty:$PANNo then $PANNo else ""', description: 'best available PAN from ledger master' });
    addField({ name: 'GSTIN', datatype: 'string', expression: 'if $$IsEmpty:$GSTIN then "" else $GSTIN', description: 'GSTIN from ledger master' });
    addField({ name: 'PartyGSTIN', datatype: 'string', expression: 'if $$IsEmpty:$PartyGSTIN then "" else $PartyGSTIN', description: 'party GSTIN from ledger master' });
    addField({ name: 'TypeOfDutyTax', datatype: 'string', expression: 'if $$IsEmpty:$TypeOfDutyTax then "" else $TypeOfDutyTax' });
    addField({ name: 'TaxType', datatype: 'string', expression: 'if $$IsEmpty:$TaxType then "" else $TaxType' });
    addField({ name: 'StatutoryType', datatype: 'string', expression: 'if $$IsEmpty:$StatutoryType then "" else $StatutoryType' });
    addField({ name: 'NatureOfPayment', datatype: 'string', expression: 'if $$IsEmpty:$NatureOfPayment then "" else $NatureOfPayment' });
    addField({ name: 'TDSNatureOfPayment', datatype: 'string', expression: 'if $$IsEmpty:$TDSNatureOfPayment then "" else $TDSNatureOfPayment' });
    addField({ name: 'IsTDSApplicable', datatype: 'string', expression: 'if $$IsEmpty:$IsTDSApplicable then "" else $IsTDSApplicable' });
    addField({ name: 'IsTDSOn', datatype: 'string', expression: 'if $$IsEmpty:$IsTDSOn then "" else $IsTDSOn' });
    addField({ name: 'Section', datatype: 'string', expression: 'if $$IsEmpty:$Section then "" else $Section' });
    addField({ name: 'TDSSection', datatype: 'string', expression: 'if $$IsEmpty:$TDSSection then "" else $TDSSection' });
  }
  if (!lstCollectionFields.some(c => c.collection === 'Voucher')) {
    lstCollectionFields.push({
      collection: 'Voucher',
      description: 'Voucher headers; for detailed TDS use tds-payment-sheet tool',
      fields: [
        { name: 'Date', datatype: 'date' },
        { name: 'VoucherNumber', datatype: 'string' },
        { name: 'VoucherTypeName', datatype: 'string' },
        { name: 'PartyLedgerName', datatype: 'string' },
        { name: 'Narration', datatype: 'string' },
        { name: 'OtherReference', datatype: 'string' }
      ]
    });
  }
  const tdsXml = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyTallyLiveReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>{{ fromDate | formatDate("d-MMM-yyyy") }}</SVFROMDATE><SVTODATE>{{ toDate | formatDate("d-MMM-yyyy") }}</SVTODATE>{% if targetCompany %}<SVCURRENTCOMPANY>{{ targetCompany | escape }}</SVCURRENTCOMPANY>{% endif %}</STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyTallyLiveReport"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart01</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MyPart01"><LINES>MyLine01</LINES><REPEAT>MyLine01 : MyCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART><LINE NAME="MyLine01"><FIELDS>FldDate,FldVoucherType,FldVoucherNumber,FldNarration,FldPartyName</FIELDS><REPEAT>MySubLine : AllLedgerEntries</REPEAT><XMLTAG>ROW</XMLTAG></LINE><LINE NAME="MySubLine"><FIELDS>FldLedgerName,FldLedgerAmount</FIELDS><XMLTAG>ALLLEDGERENTRIES.LIST</XMLTAG></LINE><FIELD NAME="FldDate"><SET>$Date</SET><XMLTAG>date</XMLTAG></FIELD><FIELD NAME="FldVoucherType"><SET>$VoucherTypeName</SET><XMLTAG>voucher_type</XMLTAG></FIELD><FIELD NAME="FldVoucherNumber"><SET>$VoucherNumber</SET><XMLTAG>voucher_number</XMLTAG></FIELD><FIELD NAME="FldNarration"><SET>$Narration</SET><XMLTAG>narration</XMLTAG></FIELD><FIELD NAME="FldPartyName"><SET>$PartyLedgerName</SET><XMLTAG>party_name</XMLTAG></FIELD><FIELD NAME="FldLedgerName"><SET>$LedgerName</SET><XMLTAG>ledger_name</XMLTAG></FIELD><FIELD NAME="FldLedgerAmount"><SET>$$StringFindAndReplace:$Amount:"(-)":"-"</SET><XMLTAG>amount</XMLTAG></FIELD><COLLECTION NAME="MyCollection"><TYPE>Voucher</TYPE>{% if partyContains %}<FILTER>FilterHasTDSLedger,FilterPartyContains,FilterCancelledVouchers,FilterOptionalVouchers</FILTER>{% else %}<FILTER>FilterHasTDSLedger,FilterCancelledVouchers,FilterOptionalVouchers</FILTER>{% endif %}<FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Narration,AllLedgerEntries</FETCH></COLLECTION><SYSTEM TYPE="Formulae" NAME="FilterHasTDSLedger">NOT $$IsEmpty:$AllLedgerEntries[1,@@FilterTDSLedger].LedgerName</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterTDSLedger">{% if tdsLedgers and tdsLedgers.length > 0 %}{% for ledger in tdsLedgers %}($LedgerName = "{{ ledger | escape }}") {% if not loop.last %}OR {% endif %}{% endfor %}{% else %}($LedgerName CONTAINS "TDS") OR ($LedgerName CONTAINS "T.D.S") OR ($LedgerName CONTAINS "T D S") OR ($LedgerName CONTAINS "TAX DEDUCTED") OR ($LedgerName CONTAINS "TAX DEDN") OR ($LedgerName CONTAINS "194") OR ($LedgerName CONTAINS "94A") OR ($LedgerName CONTAINS "94C") OR ($LedgerName CONTAINS "94H") OR ($LedgerName CONTAINS "94I") OR ($LedgerName CONTAINS "94J") OR ($LedgerName CONTAINS "94Q") OR ($LedgerName CONTAINS "94T") OR ($LedgerName CONTAINS "94N"){% endif %}</SYSTEM>{% if partyContains %}<SYSTEM TYPE="Formulae" NAME="FilterPartyContains">$PartyLedgerName CONTAINS "{{ partyContains | escape }}"</SYSTEM>{% endif %}<SYSTEM TYPE="Formulae" NAME="FilterCancelledVouchers">NOT $IsCancelled</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterOptionalVouchers">NOT $IsOptional</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
  if (!lstReportXml.has('tds-payment-sheet')) lstReportXml.set('tds-payment-sheet', tdsXml);
  if (!lstReportConfig.some(r => r.name === 'tds-payment-sheet')) {
    lstReportConfig.push({
      name: 'tds-payment-sheet',
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
  const gstr2bPurchaseXml = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyTallyLiveReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>{{ fromDate | formatDate("d-MMM-yyyy") }}</SVFROMDATE><SVTODATE>{{ toDate | formatDate("d-MMM-yyyy") }}</SVTODATE>{% if targetCompany %}<SVCURRENTCOMPANY>{{ targetCompany | escape }}</SVCURRENTCOMPANY>{% endif %}</STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyTallyLiveReport"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart01</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MyPart01"><LINES>MyLine01</LINES><REPEAT>MyLine01 : MyCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART><LINE NAME="MyLine01"><FIELDS>FldDate,FldInvoiceDate,FldVoucherType,FldVoucherNumber,FldInvoiceNumber,FldParty,FldSupplierGSTIN,FldTaxableValue,FldIGST,FldCGST,FldSGST,FldCESS,FldNarration</FIELDS><XMLTAG>ROW</XMLTAG></LINE><FIELD NAME="FldDate"><SET>$Date</SET><XMLTAG>date</XMLTAG></FIELD><FIELD NAME="FldInvoiceDate"><SET>if $$IsEmpty:$ReferenceDate then $Date else $ReferenceDate</SET><XMLTAG>invoice_date</XMLTAG></FIELD><FIELD NAME="FldVoucherType"><SET>$VoucherTypeName</SET><XMLTAG>voucher_type</XMLTAG></FIELD><FIELD NAME="FldVoucherNumber"><SET>$VoucherNumber</SET><XMLTAG>voucher_number</XMLTAG></FIELD><FIELD NAME="FldInvoiceNumber"><SET>if $$IsEmpty:$Reference then $VoucherNumber else $Reference</SET><XMLTAG>invoice_number</XMLTAG></FIELD><FIELD NAME="FldParty"><SET>$PartyLedgerName</SET><XMLTAG>supplier_name</XMLTAG></FIELD><FIELD NAME="FldSupplierGSTIN"><SET>if NOT $$IsEmpty:$PartyGSTIN then $PartyGSTIN else if NOT $$IsEmpty:($GSTIN:Ledger:$PartyLedgerName) then $GSTIN:Ledger:$PartyLedgerName else if NOT $$IsEmpty:($PartyGSTIN:Ledger:$PartyLedgerName) then $PartyGSTIN:Ledger:$PartyLedgerName else ""</SET><XMLTAG>supplier_gstin</XMLTAG></FIELD><FIELD NAME="FldTaxableValue"><SET>$$StringFindAndReplace:(if NOT $$IsEmpty:$AllLedgerEntries[1,@@FilterTaxableLedger].LedgerName then (if $$IsDebit:($AllLedgerEntries[1,@@FilterTaxableLedger].Amount) then $$NumValue:$AllLedgerEntries[1,@@FilterTaxableLedger].Amount else -$$NumValue:$AllLedgerEntries[1,@@FilterTaxableLedger].Amount) else (if $$IsDebit:($AllLedgerEntries[1,@@FilterPartyLedger].Amount) then $$NumValue:$AllLedgerEntries[1,@@FilterPartyLedger].Amount else -$$NumValue:$AllLedgerEntries[1,@@FilterPartyLedger].Amount)):"(-)":"-"</SET><XMLTAG>taxable_value</XMLTAG></FIELD><FIELD NAME="FldIGST"><SET>if $$IsEmpty:$AllLedgerEntries[1,@@FilterIGSTLedger].LedgerName then 0 else $$StringFindAndReplace:(if $$IsDebit:($AllLedgerEntries[1,@@FilterIGSTLedger].Amount) then $$NumValue:$AllLedgerEntries[1,@@FilterIGSTLedger].Amount else -$$NumValue:$AllLedgerEntries[1,@@FilterIGSTLedger].Amount):"(-)":"-"</SET><XMLTAG>igst</XMLTAG></FIELD><FIELD NAME="FldCGST"><SET>if $$IsEmpty:$AllLedgerEntries[1,@@FilterCGSTLedger].LedgerName then 0 else $$StringFindAndReplace:(if $$IsDebit:($AllLedgerEntries[1,@@FilterCGSTLedger].Amount) then $$NumValue:$AllLedgerEntries[1,@@FilterCGSTLedger].Amount else -$$NumValue:$AllLedgerEntries[1,@@FilterCGSTLedger].Amount):"(-)":"-"</SET><XMLTAG>cgst</XMLTAG></FIELD><FIELD NAME="FldSGST"><SET>if $$IsEmpty:$AllLedgerEntries[1,@@FilterSGSTLedger].LedgerName then 0 else $$StringFindAndReplace:(if $$IsDebit:($AllLedgerEntries[1,@@FilterSGSTLedger].Amount) then $$NumValue:$AllLedgerEntries[1,@@FilterSGSTLedger].Amount else -$$NumValue:$AllLedgerEntries[1,@@FilterSGSTLedger].Amount):"(-)":"-"</SET><XMLTAG>sgst</XMLTAG></FIELD><FIELD NAME="FldCESS"><SET>if $$IsEmpty:$AllLedgerEntries[1,@@FilterCESSLedger].LedgerName then 0 else $$StringFindAndReplace:(if $$IsDebit:($AllLedgerEntries[1,@@FilterCESSLedger].Amount) then $$NumValue:$AllLedgerEntries[1,@@FilterCESSLedger].Amount else -$$NumValue:$AllLedgerEntries[1,@@FilterCESSLedger].Amount):"(-)":"-"</SET><XMLTAG>cess</XMLTAG></FIELD><FIELD NAME="FldNarration"><SET>$Narration</SET><XMLTAG>narration</XMLTAG></FIELD><COLLECTION NAME="MyCollection"><TYPE>Voucher</TYPE><FETCH>Date,Reference,ReferenceDate,VoucherNumber,VoucherTypeName,PartyLedgerName,PartyGSTIN,Narration,AllLedgerEntries</FETCH><FILTER>FilterPurchaseVoucher,FilterNotCancelled,FilterNotOptional</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="FilterPurchaseVoucher">($Parent:VoucherType:$VoucherTypeName CONTAINS "Purchase") OR ($VoucherTypeName CONTAINS "Purchase")</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterTaxableLedger">NOT $$IsEqual:$LedgerName:$PartyLedgerName AND NOT ($LedgerName CONTAINS "IGST") AND NOT ($LedgerName CONTAINS "CGST") AND NOT ($LedgerName CONTAINS "SGST") AND NOT ($LedgerName CONTAINS "UTGST") AND NOT ($LedgerName CONTAINS "CESS") AND NOT ($LedgerName CONTAINS "ROUND")</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterIGSTLedger">$LedgerName CONTAINS "IGST"</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterCGSTLedger">$LedgerName CONTAINS "CGST"</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterSGSTLedger">($LedgerName CONTAINS "SGST") OR ($LedgerName CONTAINS "UTGST")</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterCESSLedger">$LedgerName CONTAINS "CESS"</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterNotCancelled">NOT $IsCancelled</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterNotOptional">NOT $IsOptional</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
  if (!lstReportXml.has('gstr-2b-purchase-register')) lstReportXml.set('gstr-2b-purchase-register', gstr2bPurchaseXml);
  if (!lstReportConfig.some(r => r.name === 'gstr-2b-purchase-register')) {
    lstReportConfig.push({ name: 'gstr-2b-purchase-register', input: [ { name: 'fromDate', datatype: 'date' }, { name: 'toDate', datatype: 'date' } ], output: [ { name: 'date', datatype: 'date' }, { name: 'invoice_date', datatype: 'date' }, { name: 'voucher_type', datatype: 'string' }, { name: 'voucher_number', datatype: 'string' }, { name: 'invoice_number', datatype: 'string' }, { name: 'supplier_name', datatype: 'string' }, { name: 'supplier_gstin', datatype: 'string' }, { name: 'taxable_value', datatype: 'number' }, { name: 'igst', datatype: 'number' }, { name: 'cgst', datatype: 'number' }, { name: 'sgst', datatype: 'number' }, { name: 'cess', datatype: 'number' }, { name: 'narration', datatype: 'string' } ] });
  }
  const voucherDetailXml = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyTallyLiveReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>{% if targetCompany %}<SVCURRENTCOMPANY>{{ targetCompany | escape }}</SVCURRENTCOMPANY>{% endif %}</STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyTallyLiveReport"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart01</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MyPart01"><LINES>MyHeaderLine</LINES><REPEAT>MyHeaderLine : MyVoucherCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART><LINE NAME="MyHeaderLine"><FIELDS>FldDate,FldVoucherType,FldVoucherNumber,FldNarration,FldPartyName</FIELDS><REPEAT>MySubLineLedger : AllLedgerEntries</REPEAT><REPEAT>MySubLineInv : AllInventoryEntries</REPEAT><XMLTAG>ROW</XMLTAG></LINE><LINE NAME="MySubLineLedger"><FIELDS>FldLedgerName,FldLedgerAmount</FIELDS><XMLTAG>ALLLEDGERENTRIES.LIST</XMLTAG></LINE><LINE NAME="MySubLineInv"><FIELDS>FldInvItemName,FldInvQty,FldInvAmount</FIELDS><XMLTAG>ALLINVENTORYENTRIES.LIST</XMLTAG></LINE><FIELD NAME="FldDate"><SET>$Date</SET><XMLTAG>date</XMLTAG></FIELD><FIELD NAME="FldVoucherType"><SET>$VoucherTypeName</SET><XMLTAG>voucher_type</XMLTAG></FIELD><FIELD NAME="FldVoucherNumber"><SET>$VoucherNumber</SET><XMLTAG>voucher_number</XMLTAG></FIELD><FIELD NAME="FldNarration"><SET>$Narration</SET><XMLTAG>narration</XMLTAG></FIELD><FIELD NAME="FldPartyName"><SET>$PartyLedgerName</SET><XMLTAG>party_name</XMLTAG></FIELD><FIELD NAME="FldLedgerName"><SET>$LedgerName</SET><XMLTAG>ledger_name</XMLTAG></FIELD><FIELD NAME="FldLedgerAmount"><SET>$$StringFindAndReplace:$Amount:"(-)":"-"</SET><XMLTAG>amount</XMLTAG></FIELD><FIELD NAME="FldInvItemName"><SET>$StockItemName</SET><XMLTAG>stock_item_name</XMLTAG></FIELD><FIELD NAME="FldInvQty"><SET>$$Number:$BilledQty</SET><XMLTAG>billed_qty</XMLTAG></FIELD><FIELD NAME="FldInvAmount"><SET>$$StringFindAndReplace:$Amount:"(-)":"-"</SET><XMLTAG>inv_amount</XMLTAG></FIELD><COLLECTION NAME="MyVoucherCollection"><TYPE>Voucher</TYPE><FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Narration,AllLedgerEntries,AllInventoryEntries</FETCH><FILTER>FilterByVoucherNumber,FilterCancelledVouchers,FilterOptionalVouchers</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="FilterByVoucherNumber">$VoucherNumber CONTAINS "{{ voucherNumber | escapeTDL }}"</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterCancelledVouchers">NOT $IsCancelled</SYSTEM><SYSTEM TYPE="Formulae" NAME="FilterOptionalVouchers">NOT $IsOptional</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
  if (!lstReportXml.has('voucher-detail')) lstReportXml.set('voucher-detail', voucherDetailXml);
}
