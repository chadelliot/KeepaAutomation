/************************************************************
* KEEPA + SOURCE LINK FINDER + SERPAPI AUTOMATION
* Spreadsheet: Keepa Automation
************************************************************/

const SPREADSHEET_ID = '1-K7gXcy5yO033paBMYR8lUkN78zZ4CPuiEF63Gcsx2U';
const KEEPA_DOMAIN = 1; // Amazon US

const SHEETS = {
  SETTINGS: 'Settings',
  RUN_LOG: 'Run Log',
  DAILY_KEEPA_PULL: 'Daily Keepa Pull',
  SOURCE_LINK_FINDER: 'Source Link Finder',
  SOURCE_SEARCH_QUEUE: 'Source Search Queue',
  SOURCE_MATCHES: 'Source Matches'
};

/************************************************************
* MAIN FUNCTIONS
************************************************************/

/**
* HOURLY KEEPA SCAN
* Appends new Keepa products without clearing the sheet.
* FIXED: rotates through Keepa query pages so it does not keep pulling same top 50.
*/
function runKeepaHourlyScan() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const logSheet = getOrCreateSheet_(ss, SHEETS.RUN_LOG);

  const props = PropertiesService.getScriptProperties();
  const pageSize = Number(props.getProperty('KEEPA_HOURLY_PAGE_SIZE') || 50);
  const maxPages = Number(props.getProperty('KEEPA_MAX_ROTATION_PAGES') || 40);
  const currentPage = Number(props.getProperty('KEEPA_QUERY_PAGE') || 0);
  const nextPage = (currentPage + 1) % maxPages;

  props.setProperty('KEEPA_QUERY_PAGE', String(nextPage));

  try {
    log_(logSheet, `Started hourly Keepa scan - page ${currentPage}`);

    const apiKey = getScriptProperty_('KEEPA_API_KEY');
    const asins = fetchKeepaAsins_(apiKey, pageSize, currentPage);

    log_(logSheet, `Fetched ${asins.length} ASINs from Keepa query page ${currentPage}`);

    if (!asins.length) {
      log_(logSheet, 'No ASINs returned. Check Keepa Product Finder filters or KEEPA_SELECTION_JSON.');
      return;
    }

    const products = fetchKeepaProducts_(apiKey, asins);
    log_(logSheet, `Fetched product details for ${products.length} ASINs`);

    appendDailyKeepaPull_(ss, products);

    SpreadsheetApp.flush();
    log_(logSheet, `Completed hourly Keepa scan - next page will be ${nextPage}`);

  } catch (err) {
    log_(logSheet, `ERROR hourly Keepa scan page ${currentPage}: ${err.message}`);
    throw err;
  }
}

/**
* Optional alias if you want to point triggers to this name.
*/
function runHourlyKeepaScanRotating() {
  runKeepaHourlyScan();
}

/**
* Resets Keepa rotation back to page 0.
* Run this manually after changing filters.
*/
function resetKeepaRotation() {
  PropertiesService.getScriptProperties().setProperty('KEEPA_QUERY_PAGE', '0');

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const logSheet = getOrCreateSheet_(ss, SHEETS.RUN_LOG);
  log_(logSheet, 'Reset Keepa query page rotation to 0');
}

/**
* Moves rows from Source Search Queue into Source Link Finder while preserving
* Source Link Finder capacity and brand diversity.
*/
function moveSourceSearchQueueToSourceLinkFinder() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const logSheet = getOrCreateSheet_(ss, SHEETS.RUN_LOG);
  const queueSheet = ss.getSheetByName(SHEETS.SOURCE_SEARCH_QUEUE);
  const finderSheet = ss.getSheetByName(SHEETS.SOURCE_LINK_FINDER);

  if (!queueSheet) {
    throw new Error('Source Search Queue tab not found.');
  }
  if (!finderSheet) {
    throw new Error('Source Link Finder tab not found.');
  }

  const props = PropertiesService.getScriptProperties();
  const finderTarget = getPositiveIntegerProperty_(props, 'SOURCE_LINK_FINDER_TARGET', 500);
  const maxPerBrand = getPositiveIntegerProperty_(props, 'SOURCE_LINK_FINDER_MAX_PER_BRAND', 5);
  const queueScanLimit = getPositiveIntegerProperty_(props, 'SOURCE_QUEUE_SCAN_LIMIT', 1000);
  const batchLimit = getPositiveIntegerProperty_(props, 'SOURCE_LINK_FINDER_BATCH_LIMIT', finderTarget);

  try {
    log_(logSheet, `Started Source Search Queue transfer. Finder target: ${finderTarget}, max per brand: ${maxPerBrand}, queue scan limit: ${queueScanLimit}`);

    const finderLastRow = finderSheet.getLastRow();
    const finderRowCount = Math.max(0, finderLastRow - 1);
    const finderCapacity = Math.max(0, finderTarget - finderRowCount);
    const runCapacity = Math.min(finderCapacity, batchLimit);

    if (runCapacity <= 0) {
      log_(logSheet, `Source Link Finder already at capacity (${finderRowCount}/${finderTarget}). Rows moved to Source Link Finder: 0`);
      return;
    }

    const queueLastRow = queueSheet.getLastRow();
    if (queueLastRow < 2) {
      log_(logSheet, 'Source Search Queue is empty. Rows moved to Source Link Finder: 0');
      return;
    }

    const finderActiveBrandCounts = getActiveFinderBrandCounts_(finderSheet);
    const finderAsins = getExistingAsins_(finderSheet);
    const scanRows = Math.min(queueScanLimit, queueLastRow - 1);
    const queueColumnCount = queueSheet.getLastColumn();
    const finderColumnCount = finderSheet.getLastColumn();
    const writeColumnCount = Math.min(queueColumnCount, finderColumnCount);
    const queueValues = queueSheet.getRange(2, 1, scanRows, queueColumnCount).getValues();

    const rowsToMove = [];
    const queueRowsToDelete = [];
    const cappedBrandSkips = {};
    let duplicateSkips = 0;

    for (let i = 0; i < queueValues.length && rowsToMove.length < runCapacity; i++) {
      const row = queueValues[i];
      const asin = String(row[1] || '').trim();
      const brandKey = normalizeBrandKey_(row[3]);
      const currentBrandCount = finderActiveBrandCounts[brandKey] || 0;

      if (asin && finderAsins.has(asin)) {
        duplicateSkips++;
        continue;
      }

      if (currentBrandCount >= maxPerBrand) {
        cappedBrandSkips[brandKey] = (cappedBrandSkips[brandKey] || 0) + 1;
        continue;
      }

      rowsToMove.push(padRow_(row.slice(0, writeColumnCount), finderColumnCount));
      queueRowsToDelete.push(i + 2);
      if (asin) finderAsins.add(asin);
      finderActiveBrandCounts[brandKey] = currentBrandCount + 1;
    }

    if (rowsToMove.length) {
      finderSheet.getRange(finderSheet.getLastRow() + 1, 1, rowsToMove.length, finderColumnCount).setValues(rowsToMove);
      deleteRowsBottomUp_(queueSheet, queueRowsToDelete);
    }

    const skippedDueToBrandCap = Object.keys(cappedBrandSkips).reduce((sum, brand) => sum + cappedBrandSkips[brand], 0);
    const topBrandsCapped = formatTopCappedBrands_(cappedBrandSkips);
    const scanLimitReached = scanRows < (queueLastRow - 1) && rowsToMove.length < runCapacity;

    SpreadsheetApp.flush();
    log_(logSheet, `Rows moved to Source Link Finder: ${rowsToMove.length}`);
    log_(logSheet, `Rows skipped due to brand cap: ${skippedDueToBrandCap}`);
    log_(logSheet, `Top brands capped: ${topBrandsCapped || 'None'}`);
    log_(logSheet, `Queue scan limit reached: ${scanLimitReached ? 'Yes' : 'No'} (${scanRows}/${queueLastRow - 1} rows scanned)`);
    if (duplicateSkips) log_(logSheet, `Rows skipped due to existing ASIN dedupe: ${duplicateSkips}`);
    log_(logSheet, 'Completed Source Search Queue transfer');
  } catch (err) {
    log_(logSheet, `ERROR Source Search Queue transfer: ${err.message}`);
    throw err;
  }
}

/**
* Optional alias for queue refill triggers.
*/
function refillSourceLinkFinderFromQueue() {
  moveSourceSearchQueueToSourceLinkFinder();
}

/**
* SERPAPI SOURCE FINDER
* Searches only API-eligible rows in Source Link Finder.
* Uses SerpApi Google Shopping results.
*/
function runSerpApiSourceFinder() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const logSheet = getOrCreateSheet_(ss, SHEETS.RUN_LOG);
  const sheet = ss.getSheetByName(SHEETS.SOURCE_LINK_FINDER);

  if (!sheet) {
    throw new Error('Source Link Finder tab not found.');
  }

  try {
    log_(logSheet, 'Started SerpApi Source Finder batch');

    const serpApiKey = getScriptProperty_('SERPAPI_API_KEY');
    const dailyCap = Number(PropertiesService.getScriptProperties().getProperty('SERPAPI_DAILY_CAP') || 8);
    const monthlyCap = Number(PropertiesService.getScriptProperties().getProperty('SERPAPI_MONTHLY_CAP') || 240);

    const usage = getSerpApiUsage_(logSheet);
    const remainingDaily = Math.max(0, dailyCap - usage.today);
    const remainingMonthly = Math.max(0, monthlyCap - usage.month);

    const cap = Math.min(remainingDaily, remainingMonthly);

    if (cap <= 0) {
      log_(logSheet, `SerpApi cap reached. Today: ${usage.today}/${dailyCap}, Month: ${usage.month}/${monthlyCap}`);
      return;
    }

    const rows = getSerpApiCandidateRows_(sheet, cap);

    if (!rows.length) {
      log_(logSheet, 'No eligible SerpApi rows ready to search.');
      return;
    }

    log_(logSheet, `Processing ${rows.length} SerpApi candidate rows`);

    rows.forEach(rowObj => {
      try {
        processSerpApiRow_(sheet, rowObj, serpApiKey);
        log_(logSheet, `SERPAPI_SEARCH row ${rowObj.rowNumber}: ${rowObj.asin} - completed`);
        Utilities.sleep(1200);
      } catch (err) {
        writeSerpApiError_(sheet, rowObj.rowNumber, err.message);
        log_(logSheet, `SERPAPI_ERROR row ${rowObj.rowNumber}: ${rowObj.asin} - ${err.message}`);
        Utilities.sleep(1200);
      }
    });

    SpreadsheetApp.flush();
    log_(logSheet, 'Completed SerpApi Source Finder batch');

  } catch (err) {
    log_(logSheet, `ERROR SerpApi Source Finder: ${err.message}`);
    throw err;
  }
}

/**
* Alias: use this when you say "run source link finder."
*/
function runSourceLinkFinder() {
  runSerpApiSourceFinder();
}

/**
* Optional manual refresh / repair.
*/
function refreshKeepaWorkbook() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  setupDailyKeepaHeaders_(ss);
  setupSerpApiColumns();
  SpreadsheetApp.flush();
}

/************************************************************
* SERPAPI SETUP
************************************************************/

/**
* Run once after pasting this script.
* Adds / repairs SerpApi columns in Source Link Finder.
*/
function setupSerpApiColumns() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.SOURCE_LINK_FINDER);

  if (!sheet) {
    throw new Error('Source Link Finder tab not found.');
  }

  const requiredColumnCount = 30;
  if (sheet.getMaxColumns() < requiredColumnCount) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumnCount - sheet.getMaxColumns());
  }

  const headers = [
    'SerpApi Priority Score',
    'API Search Eligible?',
    'API Search Status',
    'SerpApi Best Result Title',
    'SerpApi Best Retailer',
    'SerpApi Best Price',
    'SerpApi Best URL',
    'SerpApi Profit Check',
    'SerpApi Notes',
    'Last SerpApi Check'
  ];

  sheet.getRange(1, 21, 1, headers.length).setValues([headers]);

  sheet.getRange('U2').setFormula(
    '=ARRAYFORMULA(IF(B2:B="","",(IF(E2:E<>"",35,0)+IF(G2:G<>"",20,0)+IF(F2:F>=15,15,0)+IF(ISNUMBER(MATCH(LOWER(D2:D),{"carhartt","pampers","mini mic pro","partywoo"},0)),20,0)-IF(REGEXMATCH(LOWER(C2:C&" "&D2:D),"amazon fire|fire 7|iphone|renewed|refurb|locked|software|download|turbotax|coin|commemorative"),50,0)-IF(E2:E="",15,0))))'
  );

  sheet.getRange('V2').setFormula(
    '=ARRAYFORMULA(IF(B2:B="","",IF((U2:U>=55)*(G2:G<>"")*NOT(REGEXMATCH(LOWER(C2:C&" "&D2:D),"amazon fire|fire 7|iphone|renewed|refurb|locked|software|download|turbotax|coin|commemorative")),"Yes","No")))'
  );

  sheet.getRange('W2').setFormula(
    '=ARRAYFORMULA(IF(B2:B="","",IF(AD2:AD<>"","Searched",IF(V2:V="Yes","Ready","Skip"))))'
  );

  const headerRange = sheet.getRange(1, 21, 1, 10);
  headerRange
    .setBackground('#0D1F38')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setWrap(true);

  sheet.getRange('Z2:Z2500').setNumberFormat('$#,##0.00');

  const validation = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Ready', 'Searched', 'Skip', 'Error'], true)
    .setAllowInvalid(true)
    .build();

  sheet.getRange('W2:W2500').setDataValidation(validation);

  sheet.autoResizeColumns(21, 10);

  const logSheet = getOrCreateSheet_(ss, SHEETS.RUN_LOG);
  log_(logSheet, 'SerpApi columns repaired / installed on Source Link Finder.');
}

/************************************************************
* SERPAPI SEARCH LOGIC
************************************************************/

function getSerpApiCandidateRows_(sheet, cap) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const range = sheet.getRange(2, 1, lastRow - 1, 30);
  const values = range.getValues();

  const candidates = [];

  values.forEach((row, idx) => {
    const rowNumber = idx + 2;

    const asin = row[1];              // B
    const title = row[2];             // C
    const brand = row[3];             // D
    const upc = row[4];               // E
    const sellPrice = toNumber_(row[5]); // F
    const maxBuyCost = toNumber_(row[6]); // G
    const bestSearchQuery = row[8];   // I
    const moveToMatches = row[18];    // S
    const priorityScore = toNumber_(row[20]); // U
    const eligible = row[21];         // V
    const status = row[22];           // W
    const lastChecked = row[29];      // AD

    if (!asin || !title) return;
    if (eligible !== 'Yes') return;
    if (status !== 'Ready') return;
    if (moveToMatches === 'Yes') return;
    if (lastChecked) return;
    if (!maxBuyCost) return;

    candidates.push({
      rowNumber,
      asin,
      title,
      brand,
      upc,
      sellPrice,
      maxBuyCost,
      query: buildSerpApiQuery_(bestSearchQuery, upc, title, brand),
      priorityScore
    });
  });

  candidates.sort((a, b) => b.priorityScore - a.priorityScore);

  return candidates.slice(0, cap);
}

function buildSerpApiQuery_(bestSearchQuery, upc, title, brand) {
  if (upc) return String(upc).trim();
  if (bestSearchQuery) return String(bestSearchQuery).trim();

  let q = `${brand || ''} ${title || ''}`.trim();
  q = q.replace(/\s+/g, ' ');

  return q;
}

function processSerpApiRow_(sheet, rowObj, apiKey) {
  const result = searchGoogleShopping_(rowObj.query, apiKey);
  const best = pickBestShoppingResult_(result.shopping_results || [], rowObj);

  const now = new Date();

  if (!best) {
    sheet.getRange(rowObj.rowNumber, 24, 1, 7).setValues([[
      '',
      '',
      '',
      '',
      'No result',
      'No clean shopping result found under max buy cost.',
      now
    ]]);

    sheet.getRange(rowObj.rowNumber, 15, 1, 6).setValues([[
      'No clean source found',
      '',
      '',
      'Low',
      'Review',
      'SerpApi searched; no clean source result under max buy cost.'
    ]]);

    return;
  }

  const profitCheck = best.price <= rowObj.maxBuyCost ? 'Under Max Buy Cost' : 'Above Max Buy Cost';

  sheet.getRange(rowObj.rowNumber, 24, 1, 7).setValues([[
    best.title,
    best.source,
    best.price,
    best.link,
    profitCheck,
    best.notes,
    now
  ]]);

  const isCleanProfitable =
    best.price <= rowObj.maxBuyCost &&
    best.matchConfidence !== 'Low' &&
    !isRiskySource_(best.source) &&
    !isRiskyProduct_(rowObj.title, rowObj.brand);

  if (isCleanProfitable) {
    sheet.getRange(rowObj.rowNumber, 15, 1, 6).setValues([[
      best.source,
      best.link,
      best.price,
      best.matchConfidence,
      'Yes',
      `SerpApi found likely profitable match. ${best.notes}`
    ]]);
  } else {
    const moveStatus = best.price <= rowObj.maxBuyCost ? 'Review' : 'No';
    const confidence = best.price <= rowObj.maxBuyCost ? best.matchConfidence : 'Reject';

    sheet.getRange(rowObj.rowNumber, 15, 1, 6).setValues([[
      best.source || 'Source result reviewed',
      best.link || '',
      best.price || '',
      confidence,
      moveStatus,
      `SerpApi result ${profitCheck}. ${best.notes}`
    ]]);
  }
}

function searchGoogleShopping_(query, apiKey) {
  const params = {
    engine: 'google_shopping',
    q: query,
    gl: 'us',
    hl: 'en',
    api_key: apiKey
  };

  const url = 'https://serpapi.com/search.json?' + toQueryString_(params);

  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`SerpApi HTTP ${code}: ${text.slice(0, 250)}`);
  }

  const json = JSON.parse(text);

  if (json.error) {
    throw new Error(`SerpApi error: ${json.error}`);
  }

  return json;
}

function pickBestShoppingResult_(shoppingResults, rowObj) {
  if (!shoppingResults || !shoppingResults.length) return null;

  const scored = shoppingResults
    .map(item => {
      const title = item.title || '';
      const source = item.source || item.merchant || '';
      const link = item.link || item.product_link || '';
      const price = parsePrice_(item.extracted_price || item.price);

      if (!price || !title) return null;

      const matchScore = scoreShoppingMatch_(title, source, rowObj);
      const priceScore = price <= rowObj.maxBuyCost ? 40 : 0;
      const sourcePenalty = isRiskySource_(source) ? -25 : 0;
      const totalScore = matchScore + priceScore + sourcePenalty;

      let matchConfidence = 'Low';
      if (totalScore >= 75) matchConfidence = 'High';
      else if (totalScore >= 50) matchConfidence = 'Medium';

      const notes = [
        `Matched title: ${title}`,
        `Source: ${source || 'Unknown'}`,
        `Price: $${price.toFixed(2)}`,
        `Max Buy Cost: $${rowObj.maxBuyCost.toFixed(2)}`,
        `Confidence: ${matchConfidence}`
      ].join(' | ');

      return {
        title,
        source,
        link,
        price,
        matchScore,
        totalScore,
        matchConfidence,
        notes
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.totalScore - a.totalScore || a.price - b.price);

  if (!scored.length) return null;

  return scored[0];
}

function scoreShoppingMatch_(resultTitle, source, rowObj) {
  const result = normalize_(resultTitle);
  const title = normalize_(rowObj.title);
  const brand = normalize_(rowObj.brand);
  const upc = normalize_(rowObj.upc);

  let score = 0;

  if (brand && result.includes(brand)) score += 25;
  if (upc && result.includes(upc)) score += 45;

  const titleWords = title
    .split(' ')
    .filter(w => w.length >= 4)
    .slice(0, 12);

  let matchedWords = 0;

  titleWords.forEach(w => {
    if (result.includes(w)) matchedWords++;
  });

  score += Math.min(35, matchedWords * 5);

  if (source && !isRiskySource_(source)) score += 10;

  return score;
}

function isRiskySource_(source) {
  const s = normalize_(source);
  if (!s) return true;

  return /amazon|ebay|mercari|poshmark|facebook|offerup|craigslist/.test(s);
}

function isRiskyProduct_(title, brand) {
  const t = normalize_(`${brand || ''} ${title || ''}`);

  return /amazon fire|fire 7|iphone|renewed|refurb|locked|software|download|turbotax|coin|commemorative/.test(t);
}

function writeSerpApiError_(sheet, rowNumber, message) {
  const now = new Date();

  sheet.getRange(rowNumber, 23).setValue('Error'); // W, may be overwritten by formula if setup is rerun
  sheet.getRange(rowNumber, 29).setValue(`SerpApi error: ${message}`); // AC
  sheet.getRange(rowNumber, 30).setValue(now); // AD
}

/************************************************************
* KEEPA API LOGIC
************************************************************/

function fetchKeepaAsins_(apiKey, limit, page) {
  const selection = getKeepaSelection_();

  selection.page = Number(page || 0);
  selection.perPage = Number(limit || 50);

  const url =
    'https://api.keepa.com/query' +
    `?key=${encodeURIComponent(apiKey)}` +
    `&domain=${KEEPA_DOMAIN}` +
    `&selection=${encodeURIComponent(JSON.stringify(selection))}`;

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`Keepa query failed HTTP ${code}: ${text.slice(0, 250)}`);
  }

  const json = JSON.parse(text);

  if (json.error) {
    throw new Error(`Keepa query error: ${json.error.message || JSON.stringify(json.error)}`);
  }

  const asins = json.asinList || json.asins || [];

  return asins.slice(0, limit);
}

function fetchKeepaProducts_(apiKey, asins) {
  const products = [];
  const chunkSize = 100;

  for (let i = 0; i < asins.length; i += chunkSize) {
    const chunk = asins.slice(i, i + chunkSize);

    const url =
      'https://api.keepa.com/product' +
      `?key=${encodeURIComponent(apiKey)}` +
      `&domain=${KEEPA_DOMAIN}` +
      `&asin=${encodeURIComponent(chunk.join(','))}` +
      '&stats=90' +
      '&history=0' +
      '&offers=20' +
      '&buybox=1';

    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    const text = response.getContentText();

    if (code < 200 || code >= 300) {
      Utilities.sleep(15000);
      throw new Error(`Keepa product fetch failed HTTP ${code}: ${text.slice(0, 250)}`);
    }

    const json = JSON.parse(text);

    if (json.error) {
      Utilities.sleep(15000);
      throw new Error(`Keepa product error: ${json.error.message || JSON.stringify(json.error)}`);
    }

    (json.products || []).forEach(p => products.push(p));

    Utilities.sleep(1500);
  }

  return products;
}

function getKeepaSelection_() {
  const raw = PropertiesService.getScriptProperties().getProperty('KEEPA_SELECTION_JSON');

  if (raw) {
    return JSON.parse(raw);
  }

  return {
    f: {
      productType: {
        values: ['0'],
        filterType: 'set'
      }
    },
    s: [
      { colId: 'SALES_current', sort: 'asc' }
    ],
    t: 'g'
  };
}

/************************************************************
* DAILY KEEPA PULL WRITING
************************************************************/

function setupDailyKeepaHeaders_(ss) {
  const sheet = getOrCreateSheet_(ss, SHEETS.DAILY_KEEPA_PULL);

  const headers = [
    'Date Found',
    'ASIN',
    'Product Title',
    'Brand',
    'Category',
    'Amazon Link',
    'Keepa Link',
    'UPC / EAN / GTIN',
    'Current Buy Box',
    '90-Day Avg Buy Box',
    'Likely Sell Price',
    'Estimated Monthly Sales',
    'Sales Rank',
    'Sales Rank Drops 30D',
    'New Offer Count',
    'FBA Offer Count',
    'Amazon OOS %',
    'Buy Box OOS / Suppressed %',
    'Lowest FBA Price',
    'Above Buy Box Spread',
    'Opportunity Score',
    'Status',
    'Notes'
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#0D1F38')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setWrap(true);

  sheet.setFrozenRows(1);
}

function appendDailyKeepaPull_(ss, products) {
  const sheet = getOrCreateSheet_(ss, SHEETS.DAILY_KEEPA_PULL);
  setupDailyKeepaHeaders_(ss);

  const existingAsins = getExistingAsins_(sheet);
  const rows = [];

  products.forEach(product => {
    const asin = product.asin;
    if (!asin || existingAsins.has(asin)) return;

    rows.push(buildKeepaRow_(product));
    existingAsins.add(asin);
  });

  if (!rows.length) {
    const logSheet = getOrCreateSheet_(ss, SHEETS.RUN_LOG);
    log_(logSheet, 'No new ASINs to append after dedupe');
    return;
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

  sheet.getRange(2, 9, Math.max(1, sheet.getLastRow() - 1), 3).setNumberFormat('$#,##0.00');
  sheet.getRange(2, 17, Math.max(1, sheet.getLastRow() - 1), 2).setNumberFormat('0.0%');
  sheet.autoResizeColumns(1, 23);

  const logSheet = getOrCreateSheet_(ss, SHEETS.RUN_LOG);
  log_(logSheet, `Appended ${rows.length} new products to Daily Keepa Pull`);
}

function getExistingAsins_(sheet) {
  const lastRow = sheet.getLastRow();
  const set = new Set();

  if (lastRow < 2) return set;

  const values = sheet.getRange(2, 2, lastRow - 1, 1).getValues();

  values.forEach(row => {
    if (row[0]) set.add(String(row[0]).trim());
  });

  return set;
}

function buildKeepaRow_(product) {
  const asin = product.asin || '';
  const stats = product.stats || {};

  const title = product.title || '';
  const brand = product.brand || '';
  const category = getCategoryName_(product);
  const amazonLink = asin ? `https://www.amazon.com/dp/${asin}` : '';
  const keepaLink = asin ? `https://keepa.com/#!product/1-${asin}` : '';

  const upc = getUpc_(product);

  const currentBuyBox = centsToDollars_(getStatValue_(stats.current, 18));
  const avgBuyBox90 = centsToDollars_(getStatValue_(stats.avg90, 18));
  const likelySellPrice = currentBuyBox || avgBuyBox90 || '';

  const monthlySales = product.monthlySold || product.monthlySoldHistory || '';
  const salesRank = getStatValue_(stats.current, 3) || '';
  const rankDrops30 = product.salesRankDrops30 || '';
  const newOfferCount = getStatValue_(stats.current, 11) || '';
  const fbaOfferCount = getFbaOfferCount_(product);
  const lowestFba = centsToDollars_(getStatValue_(stats.current, 10));

  const amazonOosPct = '';
  const buyBoxOosPct = '';

  const aboveBuyBoxSpread =
    lowestFba && likelySellPrice
      ? round_(lowestFba - likelySellPrice, 2)
      : '';

  const opportunityScore = scoreOpportunity_({
    monthlySales,
    rankDrops30,
    newOfferCount,
    fbaOfferCount,
    amazonOosPct,
    aboveBuyBoxSpread,
    likelySellPrice
  });

  const status = opportunityScore >= 35 ? 'QUALIFIED' : 'REVIEW';

  const notes = [];

  if (Number(fbaOfferCount) <= 5 && fbaOfferCount !== '') notes.push('Low FBA competition');
  if (Number(monthlySales) >= 100) notes.push('Demand signal');
  if (Number(rankDrops30) >= 15) notes.push('Sales-rank movement');

  return [
    new Date(),
    asin,
    title,
    brand,
    category,
    amazonLink,
    keepaLink,
    upc,
    currentBuyBox,
    avgBuyBox90,
    likelySellPrice,
    monthlySales,
    salesRank,
    rankDrops30,
    newOfferCount,
    fbaOfferCount,
    amazonOosPct,
    buyBoxOosPct,
    lowestFba,
    aboveBuyBoxSpread,
    opportunityScore,
    status,
    notes.join('; ')
  ];
}

function scoreOpportunity_(data) {
  let score = 0;

  const monthlySales = Number(data.monthlySales || 0);
  const rankDrops30 = Number(data.rankDrops30 || 0);
  const newOfferCount = Number(data.newOfferCount || 0);
  const fbaOfferCount = Number(data.fbaOfferCount || 0);
  const amazonOosPct = Number(data.amazonOosPct || 0);
  const aboveBuyBoxSpread = Number(data.aboveBuyBoxSpread || 0);
  const likelySellPrice = Number(data.likelySellPrice || 0);

  score += Math.min(20, monthlySales / 25);
  score += Math.min(20, rankDrops30);

  if (fbaOfferCount && fbaOfferCount <= 5) score += 20;
  else if (fbaOfferCount && fbaOfferCount <= 7) score += 12;

  if (newOfferCount && newOfferCount <= 12) score += 10;

  score += Math.min(25, amazonOosPct * 25);

  if (aboveBuyBoxSpread > 0 && likelySellPrice > 0) {
    score += Math.min(15, (aboveBuyBoxSpread / likelySellPrice) * 100);
  }

  return round_(score, 1);
}

/************************************************************
* HELPERS
************************************************************/


function getActiveFinderBrandCounts_(sheet) {
  const lastRow = sheet.getLastRow();
  const counts = {};

  if (lastRow < 2) return counts;

  const columnCount = Math.min(Math.max(20, sheet.getLastColumn()), sheet.getMaxColumns());
  const values = sheet.getRange(2, 1, lastRow - 1, columnCount).getValues();

  values.forEach(row => {
    if (!rowHasProductIdentity_(row)) return;
    if (hasClearFinalNoOrReject_(row)) return;

    const brandKey = normalizeBrandKey_(row[3]);
    counts[brandKey] = (counts[brandKey] || 0) + 1;
  });

  return counts;
}

function rowHasProductIdentity_(row) {
  return Boolean(row[1] || row[2] || row[3]);
}

function hasClearFinalNoOrReject_(row) {
  const decisionCells = row.slice(14, 20); // O:T
  return decisionCells.some(value => {
    const normalized = normalize_(value);
    return normalized === 'no' || normalized === 'reject';
  });
}

function normalizeBrandKey_(brand) {
  const normalized = normalize_(brand);
  return normalized || '(blank brand)';
}

function getPositiveIntegerProperty_(props, key, defaultValue) {
  const value = Number(props.getProperty(key) || defaultValue);
  return value > 0 && isFinite(value) ? Math.floor(value) : defaultValue;
}

function padRow_(row, length) {
  const output = row.slice(0, length);
  while (output.length < length) output.push('');
  return output;
}

function deleteRowsBottomUp_(sheet, rowNumbers) {
  rowNumbers.slice().sort((a, b) => b - a).forEach(rowNumber => sheet.deleteRow(rowNumber));
}

function formatTopCappedBrands_(cappedBrandSkips) {
  return Object.keys(cappedBrandSkips)
    .sort((a, b) => cappedBrandSkips[b] - cappedBrandSkips[a])
    .slice(0, 10)
    .map(brand => `${brand}: ${cappedBrandSkips[brand]}`)
    .join(', ');
}

function getScriptProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error(`Missing ${key} in Script Properties.`);
  return value;
}

function getOrCreateSheet_(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function log_(sheet, message) {
  sheet.appendRow([new Date(), message]);
}

function getSerpApiUsage_(logSheet) {
  const lastRow = logSheet.getLastRow();
  if (lastRow < 2) return { today: 0, month: 0 };

  const values = logSheet.getRange(2, 1, lastRow - 1, 2).getValues();

  const now = new Date();
  const todayKey = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const monthKey = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM');

  let today = 0;
  let month = 0;

  values.forEach(row => {
    const date = row[0];
    const msg = String(row[1] || '');

    if (!(date instanceof Date)) return;
    if (!msg.startsWith('SERPAPI_SEARCH')) return;

    const rowTodayKey = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const rowMonthKey = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM');

    if (rowTodayKey === todayKey) today++;
    if (rowMonthKey === monthKey) month++;
  });

  return { today, month };
}

function getCategoryName_(product) {
  if (product.categoryTree && product.categoryTree.length) {
    return product.categoryTree[product.categoryTree.length - 1].name || '';
  }

  if (product.rootCategory) return String(product.rootCategory);

  return '';
}

function getUpc_(product) {
  const codes = [];

  if (product.upcList && product.upcList.length) codes.push(...product.upcList);
  if (product.eanList && product.eanList.length) codes.push(...product.eanList);

  return codes.length ? String(codes[0]) : '';
}

function getFbaOfferCount_(product) {
  if (product.stats && product.stats.current) {
    const v = getStatValue_(product.stats.current, 14);
    if (v !== '' && v !== -1) return v;
  }

  if (product.fbaOfferCount !== undefined) return product.fbaOfferCount;

  return '';
}

function getStatValue_(arr, index) {
  if (!arr || !Array.isArray(arr)) return '';
  const value = arr[index];

  if (value === undefined || value === null || value === -1) return '';

  return value;
}

function centsToDollars_(value) {
  if (value === '' || value === null || value === undefined || value === -1) return '';
  const n = Number(value);
  if (!isFinite(n)) return '';

  return round_(n / 100, 2);
}

function parsePrice_(value) {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'number') return round_(value, 2);

  const cleaned = String(value)
    .replace(/,/g, '')
    .match(/[\d.]+/);

  if (!cleaned) return '';

  const n = Number(cleaned[0]);

  return isFinite(n) ? round_(n, 2) : '';
}

function toNumber_(value) {
  if (value === null || value === undefined || value === '') return 0;

  if (typeof value === 'number') return value;

  const cleaned = String(value).replace(/[$,%\s,]/g, '');
  const n = Number(cleaned);

  return isFinite(n) ? n : 0;
}

function round_(num, places) {
  const p = Math.pow(10, places || 2);
  return Math.round((Number(num) + Number.EPSILON) * p) / p;
}

function normalize_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toQueryString_(params) {
  return Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}
