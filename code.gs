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
  QUALIFIED: 'Qualified',
  QUALIFIED_LEGACY: 'Qualified 2,000',
  SOURCE_LINK_FINDER: 'Source Link Finder',
  SOURCE_LINK_FINDER_ARCHIVE: 'Source Link Finder Archive',
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
  const pageSize = getPositiveIntegerProperty_(props, 'KEEPA_HOURLY_PAGE_SIZE', 50);
  const maxPages = getPositiveIntegerProperty_(props, 'KEEPA_MAX_ROTATION_PAGES', 40);
  const maxCandidatesToEvaluate = getPositiveIntegerProperty_(props, 'KEEPA_BRAND_DIVERSITY_SCAN_LIMIT', 250);
  const minTokensToContinue = getPositiveIntegerProperty_(props, 'KEEPA_MIN_TOKENS_TO_CONTINUE', 50);
  const currentPage = Number(props.getProperty('KEEPA_QUERY_PAGE') || 0);
  const requestedPagesToScan = Math.max(1, Math.ceil(maxCandidatesToEvaluate / pageSize));
  const maxPagesToScan = Math.min(requestedPagesToScan, maxPages);
  const tokenGuard = {
    minTokensToContinue,
    tokensLeft: null,
    stopReason: ''
  };

  let pagesScanned = 0;
  let candidatesFetched = 0;
  let nextPage = currentPage;
  const products = [];

  try {
    log_(logSheet, `Started hourly Keepa scan - page ${currentPage}`);

    const apiKey = getScriptProperty_('KEEPA_API_KEY');

    if (requestedPagesToScan > maxPages) {
      log_(logSheet, `WARNING Keepa brand diversity scan would wrap past configured rotation pages (${requestedPagesToScan}/${maxPages}); stopping before repeated page/API calls.`);
    }

    while (pagesScanned < maxPagesToScan && candidatesFetched < maxCandidatesToEvaluate && !tokenGuard.stopReason) {
      const page = (currentPage + pagesScanned) % maxPages;
      let asins = [];
      try {
        asins = fetchKeepaAsins_(apiKey, pageSize, page, tokenGuard);
      } catch (err) {
        if (!isKeepaGracefulStop_(err)) throw err;
        tokenGuard.stopReason = err.message;
        log_(logSheet, `WARNING ${tokenGuard.stopReason}`);
        break;
      }

      candidatesFetched += asins.length;

      log_(logSheet, `Fetched ${asins.length} ASINs from Keepa query page ${page}`);

      if (!asins.length) break;
      if (tokenGuard.stopReason) {
        log_(logSheet, `WARNING ${tokenGuard.stopReason}`);
        break;
      }

      const remainingEvaluationSlots = Math.max(0, maxCandidatesToEvaluate - (candidatesFetched - asins.length));
      const asinsToFetch = asins.slice(0, remainingEvaluationSlots);
      let pageProducts = [];
      try {
        pageProducts = fetchKeepaProducts_(apiKey, asinsToFetch, tokenGuard);
      } catch (err) {
        if (!isKeepaGracefulStop_(err)) throw err;
        tokenGuard.stopReason = err.message;
        log_(logSheet, `WARNING ${tokenGuard.stopReason}`);
        break;
      }

      products.push.apply(products, pageProducts);
      log_(logSheet, `Fetched product details for ${pageProducts.length} ASINs from page ${page}`);

      pagesScanned++;
      nextPage = (page + 1) % maxPages;

      const preview = selectKeepaProductsForAppend_(ss, products, pageSize, props);
      if (preview.rows.length >= pageSize) break;
      if (tokenGuard.stopReason) break;

      if (pagesScanned >= maxPagesToScan && preview.rows.length < pageSize) {
        log_(logSheet, `WARNING Keepa brand diversity scan limit reached before filling target: ${preview.rows.length}/${pageSize} qualified diverse products.`);
      }
    }

    props.setProperty('KEEPA_QUERY_PAGE', String(nextPage));

    if (!products.length) {
      log_(logSheet, `Keepa candidates fetched: ${candidatesFetched}`);
      log_(logSheet, `Token-limit stop/warning: ${tokenGuard.stopReason || 'None'}${tokenGuard.tokensLeft !== null ? ` (tokens left: ${tokenGuard.tokensLeft})` : ''}`);
      log_(logSheet, tokenGuard.stopReason ? 'No products appended because Keepa token/API guard stopped before product details were available.' : 'No ASINs returned. Check Keepa Product Finder filters or KEEPA_SELECTION_JSON.');
      return;
    }

    const appendStats = appendDailyKeepaPull_(ss, products, { appendLimit: pageSize });

    SpreadsheetApp.flush();
    log_(logSheet, `Keepa candidates fetched: ${candidatesFetched}`);
    log_(logSheet, `Keepa candidates evaluated: ${appendStats.evaluated}`);
    log_(logSheet, `Candidates deduped: ${appendStats.duplicateSkips}`);
    log_(logSheet, `Candidates passing pre-ingestion score: ${appendStats.opportunityPasses}`);
    log_(logSheet, `Candidates skipped as weak: ${appendStats.weakSkips}`);
    log_(logSheet, `Products appended: ${appendStats.appended}`);
    log_(logSheet, `Products skipped due to brand cap: ${appendStats.brandCapSkips}`);
    log_(logSheet, `Top capped brands: ${appendStats.topCappedBrands || 'None'}`);
    log_(logSheet, `Token-limit stop/warning: ${tokenGuard.stopReason || 'None'}${tokenGuard.tokensLeft !== null ? ` (tokens left: ${tokenGuard.tokensLeft})` : ''}`);
    log_(logSheet, `Deeper page scanning used: ${pagesScanned > 1 ? 'Yes' : 'No'} (${pagesScanned} page${pagesScanned === 1 ? '' : 's'})`);
    log_(logSheet, `Completed hourly Keepa scan - next page will be ${nextPage}`);

  } catch (err) {
    props.setProperty('KEEPA_QUERY_PAGE', String(nextPage));
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
* Runs the automated sourcing workflow end-to-end.
*/
function runAutomatedSourcingPipeline() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const logSheet = getOrCreateSheet_(ss, SHEETS.RUN_LOG);

  log_(logSheet, 'Started automated sourcing pipeline');
  getQualifiedSheet_(ss, logSheet);
  moveApprovedSourceMatches();
  cleanupSourceLinkFinderRejectedRows();
  moveSourceSearchQueueToSourceLinkFinder();
  runSerpApiSourceFinder();
  moveApprovedSourceMatches();
  cleanupSourceLinkFinderRejectedRows();
  log_(logSheet, 'Completed automated sourcing pipeline');
}

/**
* Moves rows from Source Search Queue into Source Link Finder while preserving
* brand diversity and ASIN dedupe.
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
  const maxPerBrand = getPositiveIntegerProperty_(props, 'SOURCE_LINK_FINDER_MAX_PER_BRAND', 5);
  const queueScanLimit = getPositiveIntegerProperty_(props, 'SOURCE_QUEUE_SCAN_LIMIT', 1000);
  const batchLimit = getPositiveIntegerProperty_(props, 'SOURCE_LINK_FINDER_BATCH_LIMIT', 100);

  try {
    log_(logSheet, `Started Source Search Queue transfer. Max per brand: ${maxPerBrand}, batch limit: ${batchLimit}, queue scan limit: ${queueScanLimit}`);

    moveApprovedSourceMatches();
    cleanupSourceLinkFinderRejectedRows();

    const finderStats = getFinderProductRowStats_(finderSheet);

    log_(logSheet, `Active rows after cleanup: ${finderStats.activeProductRows}`);

    const queueLastRow = queueSheet.getLastRow();
    if (queueLastRow < 2) {
      log_(logSheet, 'Source Search Queue is empty. Rows moved to Source Link Finder: 0');
      return;
    }

    const finderActiveBrandCounts = getActiveFinderBrandCounts_(finderSheet);
    const existingProductKeys = getExistingProductKeysAcrossSheets_(ss, [
      SHEETS.SOURCE_LINK_FINDER,
      SHEETS.SOURCE_MATCHES,
      SHEETS.SOURCE_LINK_FINDER_ARCHIVE
    ]);
    const scanRows = Math.min(queueScanLimit, queueLastRow - 1);
    const queueColumnCount = queueSheet.getLastColumn();
    const finderColumnCount = finderSheet.getLastColumn();
    const writeColumnCount = Math.min(queueColumnCount, finderColumnCount);
    const queueValues = queueSheet.getRange(2, 1, scanRows, queueColumnCount).getValues();

    const rowsToMove = [];
    const queueRowsToDelete = [];
    const cappedBrandSkips = {};
    let duplicateSkips = 0;

    for (let i = 0; i < queueValues.length && rowsToMove.length < batchLimit; i++) {
      const row = queueValues[i];
      const asin = String(row[1] || '').trim();
      const upc = String(row[4] || '').trim();
      const brandKey = normalizeBrandKey_(row[3]);
      const currentBrandCount = finderActiveBrandCounts[brandKey] || 0;

      if ((asin && existingProductKeys.asins.has(asin)) || (upc && existingProductKeys.upcs.has(upc))) {
        duplicateSkips++;
        continue;
      }

      if (currentBrandCount >= maxPerBrand) {
        cappedBrandSkips[brandKey] = (cappedBrandSkips[brandKey] || 0) + 1;
        continue;
      }

      rowsToMove.push(padRow_(row.slice(0, writeColumnCount), finderColumnCount));
      queueRowsToDelete.push(i + 2);
      if (asin) existingProductKeys.asins.add(asin);
      if (upc) existingProductKeys.upcs.add(upc);
      finderActiveBrandCounts[brandKey] = currentBrandCount + 1;
    }

    if (rowsToMove.length) {
      writeRowsToFinderProductSlots_(finderSheet, rowsToMove, finderStats.emptyProductRows, finderColumnCount);
      deleteRowsBottomUp_(queueSheet, queueRowsToDelete);
    }

    const skippedDueToBrandCap = Object.keys(cappedBrandSkips).reduce((sum, brand) => sum + cappedBrandSkips[brand], 0);
    const topBrandsCapped = formatTopCappedBrands_(cappedBrandSkips);
    const scanLimitReached = scanRows < (queueLastRow - 1);

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
* Archives Source Link Finder rows that are clearly rejected / complete.
* Approved Yes rows are handled by moveApprovedSourceMatches().
*/
function cleanupSourceLinkFinderRejectedRows() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const logSheet = getOrCreateSheet_(ss, SHEETS.RUN_LOG);
  const finderSheet = ss.getSheetByName(SHEETS.SOURCE_LINK_FINDER);

  if (!finderSheet) {
    throw new Error('Source Link Finder tab not found.');
  }

  const props = PropertiesService.getScriptProperties();
  const reviewMaxAgeDays = getPositiveIntegerProperty_(props, 'SOURCE_REVIEW_MAX_AGE_DAYS', 2);
  const lastRow = finderSheet.getLastRow();
  const sourceColumnCount = finderSheet.getLastColumn();

  if (lastRow < 2 || sourceColumnCount < 1) {
    log_(logSheet, 'Rows archived from Source Link Finder: 0');
    return 0;
  }

  const values = finderSheet.getRange(2, 1, lastRow - 1, sourceColumnCount).getValues();
  const rowsToArchive = [];
  const rowsToDelete = [];

  values.forEach((row, index) => {
    if (!rowHasProductIdentity_(row)) return;
    if (hasApprovedMoveDecision_(row)) return;

    const shouldArchive =
      hasRejectedMoveDecision_(row) ||
      hasClearFinalRejectedDecision_(row) ||
      (!hasReviewMoveDecision_(row) && hasSkipSearchStatus_(row)) ||
      hasStaleReviewDecision_(row, reviewMaxAgeDays);

    if (!shouldArchive) return;

    rowsToArchive.push(padRow_(row, sourceColumnCount));
    rowsToDelete.push(index + 2);
  });

  if (!rowsToArchive.length) {
    log_(logSheet, 'Rows archived from Source Link Finder: 0');
    return 0;
  }

  const archiveSheet = getOrCreateSheet_(ss, SHEETS.SOURCE_LINK_FINDER_ARCHIVE);
  ensureSheetColumns_(archiveSheet, sourceColumnCount);
  ensureDestinationSheetHeaders_(finderSheet, archiveSheet, sourceColumnCount);

  archiveSheet
    .getRange(archiveSheet.getLastRow() + 1, 1, rowsToArchive.length, sourceColumnCount)
    .setValues(rowsToArchive);

  deleteRowsBottomUp_(finderSheet, rowsToDelete);
  SpreadsheetApp.flush();

  log_(logSheet, `Rows archived from Source Link Finder: ${rowsToArchive.length}`);
  return rowsToArchive.length;
}

/**
* Moves approved Source Link Finder rows into Source Matches.
*/
function moveApprovedSourceMatches() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const logSheet = getOrCreateSheet_(ss, SHEETS.RUN_LOG);
  const finderSheet = ss.getSheetByName(SHEETS.SOURCE_LINK_FINDER);

  if (!finderSheet) {
    throw new Error('Source Link Finder tab not found.');
  }

  const lastRow = finderSheet.getLastRow();
  const sourceColumnCount = finderSheet.getLastColumn();

  if (lastRow < 2 || sourceColumnCount < 1) {
    log_(logSheet, 'Rows moved to Source Matches: 0');
    return 0;
  }

  const values = finderSheet.getRange(2, 1, lastRow - 1, sourceColumnCount).getValues();
  const rowsToMove = [];
  const rowsToDelete = [];

  values.forEach((row, index) => {
    if (!rowHasProductIdentity_(row)) return;
    if (!hasApprovedMoveDecision_(row)) return;

    rowsToMove.push(padRow_(row, sourceColumnCount));
    rowsToDelete.push(index + 2);
  });

  if (!rowsToMove.length) {
    log_(logSheet, 'Rows moved to Source Matches: 0');
    return 0;
  }

  const matchesSheet = getOrCreateSheet_(ss, SHEETS.SOURCE_MATCHES);
  ensureSheetColumns_(matchesSheet, sourceColumnCount);
  ensureDestinationSheetHeaders_(finderSheet, matchesSheet, sourceColumnCount);

  matchesSheet
    .getRange(matchesSheet.getLastRow() + 1, 1, rowsToMove.length, sourceColumnCount)
    .setValues(rowsToMove);

  deleteRowsBottomUp_(finderSheet, rowsToDelete);
  SpreadsheetApp.flush();

  log_(logSheet, `Rows moved to Source Matches: ${rowsToMove.length}`);
  return rowsToMove.length;
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
    ensureOpportunityScoringColumns_(sheet);

    const serpApiKey = getScriptProperty_('SERPAPI_API_KEY');
    const dailyCap = Number(PropertiesService.getScriptProperties().getProperty('SERPAPI_DAILY_CAP') || 8);
    const monthlyCap = Number(PropertiesService.getScriptProperties().getProperty('SERPAPI_MONTHLY_CAP') || 240);

    const usage = getSerpApiUsage_(logSheet);
    const remainingDaily = Math.max(0, dailyCap - usage.today);
    const remainingMonthly = Math.max(0, monthlyCap - usage.month);

    const cap = Math.min(remainingDaily, remainingMonthly);

    if (cap <= 0) {
      moveApprovedSourceMatches();
      cleanupSourceLinkFinderRejectedRows();
      log_(logSheet, `SerpApi cap reached. Today: ${usage.today}/${dailyCap}, Month: ${usage.month}/${monthlyCap}`);
      return;
    }

    const rows = getSerpApiCandidateRows_(sheet, cap);

    if (!rows.length) {
      moveApprovedSourceMatches();
      cleanupSourceLinkFinderRejectedRows();
      log_(logSheet, 'No eligible SerpApi rows ready to search.');
      return;
    }

    log_(logSheet, `Processing ${rows.length} SerpApi candidate rows`);

    let autoApproved = 0;
    let autoRejected = 0;
    let leftReview = 0;

    rows.forEach(rowObj => {
      try {
        const result = processSerpApiRow_(sheet, rowObj, serpApiKey);
        if (result.decision === 'Yes') autoApproved++;
        if (result.decision === 'No') autoRejected++;
        if (result.decision === 'Review') leftReview++;
        log_(logSheet, `SERPAPI_SEARCH row ${rowObj.rowNumber}: ${rowObj.asin} - completed with ${result.decision}`);
        Utilities.sleep(1200);
      } catch (err) {
        writeSerpApiError_(sheet, rowObj.rowNumber, err.message);
        autoRejected++;
        log_(logSheet, `SERPAPI_ERROR row ${rowObj.rowNumber}: ${rowObj.asin} - ${err.message}`);
        Utilities.sleep(1200);
      }
    });

    SpreadsheetApp.flush();
    log_(logSheet, `Rows auto-approved Yes: ${autoApproved}`);
    log_(logSheet, `Rows auto-rejected No: ${autoRejected}`);
    log_(logSheet, `Rows left Review: ${leftReview}`);
    moveApprovedSourceMatches();
    cleanupSourceLinkFinderRejectedRows();
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
  getQualifiedSheet_(ss, getOrCreateSheet_(ss, SHEETS.RUN_LOG));
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

  const requiredColumnCount = 35;
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
    'Last SerpApi Check',
    'Opportunity Score',
    'Profit Signal',
    'Margin Signal',
    'Velocity Signal',
    'Match Signal'
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

  const headerRange = sheet.getRange(1, 21, 1, headers.length);
  headerRange
    .setBackground('#0D1F38')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setWrap(true);

  sheet.getRange('Z2:Z2500').setNumberFormat('$#,##0.00');
  sheet.getRange('AE2:AE2500').setNumberFormat('0');

  const validation = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Ready', 'Searched', 'Skip', 'Error'], true)
    .setAllowInvalid(true)
    .build();

  sheet.getRange('W2:W2500').setDataValidation(validation);

  sheet.autoResizeColumns(21, headers.length);

  const logSheet = getOrCreateSheet_(ss, SHEETS.RUN_LOG);
  log_(logSheet, 'SerpApi columns repaired / installed on Source Link Finder.');
}

function ensureOpportunityScoringColumns_(sheet) {
  const requiredColumnCount = 35;
  if (sheet.getMaxColumns() < requiredColumnCount) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumnCount - sheet.getMaxColumns());
  }

  const headers = [
    'Opportunity Score',
    'Profit Signal',
    'Margin Signal',
    'Velocity Signal',
    'Match Signal'
  ];

  sheet.getRange(1, 31, 1, headers.length).setValues([headers]);
  sheet.getRange('AE2:AE2500').setNumberFormat('0');
}

/************************************************************
* SERPAPI SEARCH LOGIC
************************************************************/

function getSerpApiCandidateRows_(sheet, cap) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const range = sheet.getRange(2, 1, lastRow - 1, Math.max(35, sheet.getLastColumn()));
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
    const monthlySales = toNumber_(row[11]); // L
    const salesRankDrops = toNumber_(row[13]); // N
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
      monthlySales,
      salesRankDrops,
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
      'Reject',
      'No',
      'No credible profitable source found under max buy cost.'
    ]]);
    writeOpportunitySignals_(sheet, rowObj.rowNumber, buildOpportunitySignals_(rowObj, null));

    return { decision: 'No' };
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

  const opportunitySignals = buildOpportunitySignals_(rowObj, best);
  writeOpportunitySignals_(sheet, rowObj.rowNumber, opportunitySignals);

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
      `Auto-approved clean profitable source. ${best.notes}`
    ]]);

    return { decision: 'Yes' };
  }

  const isAmbiguousPromising = isPromisingButIncomplete_(best, rowObj);
  const moveStatus = isAmbiguousPromising ? 'Review' : 'No';
  const confidence = moveStatus === 'Review' ? best.matchConfidence : 'Reject';
  const notes = moveStatus === 'Review'
    ? `Ambiguous but promising; data incomplete. ${best.notes}`
    : buildAutoRejectNotes_(best, rowObj, profitCheck);

  sheet.getRange(rowObj.rowNumber, 15, 1, 6).setValues([[
    best.source || 'Source result reviewed',
    best.link || '',
    best.price || '',
    confidence,
    moveStatus,
    notes
  ]]);

  return { decision: moveStatus };
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

      const matchSignals = getShoppingMatchSignals_(title, source, rowObj);
      const matchScore = matchSignals.score;
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
        upcMatched: matchSignals.upcMatched,
        brandMatched: matchSignals.brandMatched,
        titleOverlap: matchSignals.titleOverlap,
        titleWordsChecked: matchSignals.titleWordsChecked,
        notes
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.totalScore - a.totalScore || a.price - b.price);

  if (!scored.length) return null;

  return scored[0];
}

function getShoppingMatchSignals_(resultTitle, source, rowObj) {
  const result = normalize_(resultTitle);
  const title = normalize_(rowObj.title);
  const brand = normalize_(rowObj.brand);
  const upc = normalize_(rowObj.upc);

  let score = 0;
  const brandMatched = Boolean(brand && result.includes(brand));
  const upcMatched = Boolean(upc && result.includes(upc));

  if (brandMatched) score += 25;
  if (upcMatched) score += 45;

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

  return {
    score,
    upcMatched,
    brandMatched,
    titleOverlap: titleWords.length ? matchedWords / titleWords.length : 0,
    titleWordsChecked: titleWords.length
  };
}

function scoreShoppingMatch_(resultTitle, source, rowObj) {
  return getShoppingMatchSignals_(resultTitle, source, rowObj).score;
}

function isRiskySource_(source) {
  const s = normalize_(source);
  if (!s) return true;

  return /amazon|ebay|mercari|poshmark|facebook|offerup|craigslist/.test(s);
}

function isRiskyProduct_(title, brand) {
  const t = normalize_(`${brand || ''} ${title || ''}`);

  return /amazon fire|fire 7|iphone|renewed|refurb|refurbished|locked|software|download|app store|digital code|gift card|subscription|subscribe|turbotax|coin|commemorative/.test(t);
}


function isPromisingButIncomplete_(best, rowObj) {
  if (best.price > rowObj.maxBuyCost) return false;
  if (isRiskySource_(best.source) || isRiskyProduct_(rowObj.title, rowObj.brand)) return false;

  const hasIncompleteIdentity = !rowObj.upc || !rowObj.brand || !rowObj.title;
  return hasIncompleteIdentity && best.matchConfidence === 'Low';
}

function buildAutoRejectNotes_(best, rowObj, profitCheck) {
  const reasons = [];

  if (best.price > rowObj.maxBuyCost) reasons.push('above max buy cost');
  if (best.matchConfidence === 'Low') reasons.push('low match confidence');
  if (isRiskySource_(best.source)) reasons.push('risky source');
  if (isRiskyProduct_(rowObj.title, rowObj.brand)) reasons.push('risky product');

  const reasonText = reasons.length ? reasons.join(', ') : 'not a credible profitable source';
  return `Auto-rejected: ${reasonText}. ${profitCheck}.`;
}


function buildOpportunitySignals_(rowObj, best) {
  if (!best) {
    return {
      score: 0,
      profitSignal: 'No source',
      marginSignal: 'No source',
      velocitySignal: buildVelocitySignal_(rowObj),
      matchSignal: 'No credible match'
    };
  }

  const expectedProfit = Math.max(0, rowObj.maxBuyCost - best.price);
  const margin = best.price ? expectedProfit / best.price : 0;
  const profitable = expectedProfit >= 2 && best.price <= rowObj.maxBuyCost;
  const marginOk = margin >= 0.15;
  const velocityScore = getVelocityScore_(rowObj);
  const legitimateRetailer = !isRiskySource_(best.source);
  const productAllowed = !isRiskyProduct_(rowObj.title, rowObj.brand);

  let score = 0;
  if (profitable) score += 25;
  if (marginOk) score += 15;
  score += velocityScore;
  if (best.price <= rowObj.maxBuyCost) score += 15;
  if (best.matchConfidence === 'High') score += 20;
  else if (best.matchConfidence === 'Medium') score += 12;
  if (best.upcMatched) score += 15;
  if (best.brandMatched) score += 10;
  score += Math.min(10, Math.round((best.titleOverlap || 0) * 10));
  if (legitimateRetailer) score += 10;
  if (!productAllowed) score -= 30;

  return {
    score: Math.max(0, Math.min(100, score)),
    profitSignal: profitable ? `Profit >= $2 ($${expectedProfit.toFixed(2)})` : `Profit below threshold ($${expectedProfit.toFixed(2)})`,
    marginSignal: marginOk ? `Margin ${(margin * 100).toFixed(0)}%` : `Margin below 15% (${(margin * 100).toFixed(0)}%)`,
    velocitySignal: buildVelocitySignal_(rowObj),
    matchSignal: buildMatchSignal_(best, legitimateRetailer, productAllowed)
  };
}

function writeOpportunitySignals_(sheet, rowNumber, signals) {
  ensureSheetColumns_(sheet, 35);
  sheet.getRange(rowNumber, 31, 1, 5).setValues([[
    signals.score,
    signals.profitSignal,
    signals.marginSignal,
    signals.velocitySignal,
    signals.matchSignal
  ]]);
}

function getVelocityScore_(rowObj) {
  const monthlySales = Number(rowObj.monthlySales || 0);
  const salesRankDrops = Number(rowObj.salesRankDrops || 0);
  return Math.min(15, Math.floor(monthlySales / 20) + Math.floor(salesRankDrops / 2));
}

function buildVelocitySignal_(rowObj) {
  const monthlySales = Number(rowObj.monthlySales || 0);
  const salesRankDrops = Number(rowObj.salesRankDrops || 0);
  if (!monthlySales && !salesRankDrops) return 'No velocity data';
  return `Monthly sales: ${monthlySales || 0}; rank drops: ${salesRankDrops || 0}`;
}

function buildMatchSignal_(best, legitimateRetailer, productAllowed) {
  const parts = [
    best.matchConfidence,
    best.upcMatched ? 'UPC match' : 'UPC not confirmed',
    best.brandMatched ? 'brand match' : 'brand not confirmed',
    `title overlap ${Math.round((best.titleOverlap || 0) * 100)}%`,
    legitimateRetailer ? 'legitimate retailer' : 'risky source',
    productAllowed ? 'allowed product' : 'risky product'
  ];

  return parts.join('; ');
}

function writeSerpApiError_(sheet, rowNumber, message) {
  const now = new Date();
  const conciseMessage = String(message || '').slice(0, 180);

  sheet.getRange(rowNumber, 15, 1, 6).setValues([[
    'Source search error',
    '',
    '',
    'Reject',
    'No',
    `Auto-rejected: SerpApi error. ${conciseMessage}`
  ]]);
  writeOpportunitySignals_(sheet, rowNumber, {
    score: 0,
    profitSignal: 'Search error',
    marginSignal: 'Search error',
    velocitySignal: 'Search error',
    matchSignal: 'Search error'
  });
  sheet.getRange(rowNumber, 23).setValue('Error'); // W, may be overwritten by formula if setup is rerun
  sheet.getRange(rowNumber, 29).setValue(`SerpApi error: ${conciseMessage}`); // AC
  sheet.getRange(rowNumber, 30).setValue(now); // AD
}

/************************************************************
* KEEPA API LOGIC
************************************************************/

function fetchKeepaAsins_(apiKey, limit, page, tokenGuard) {
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

  if (code === 429) {
    throw createKeepaGracefulStop_(`Keepa token/API limit stop: HTTP 429 on query page ${page}.`);
  }

  if (code < 200 || code >= 300) {
    throw new Error(`Keepa query failed HTTP ${code}: ${text.slice(0, 250)}`);
  }

  const json = JSON.parse(text);

  if (json.error) {
    if (isKeepaTokenLimitError_(json.error)) {
      throw createKeepaGracefulStop_(`Keepa token/API limit stop: ${json.error.message || JSON.stringify(json.error)}`);
    }
    throw new Error(`Keepa query error: ${json.error.message || JSON.stringify(json.error)}`);
  }

  updateKeepaTokenGuard_(tokenGuard, json, `Keepa tokens below KEEPA_MIN_TOKENS_TO_CONTINUE after query page ${page}`);

  const asins = json.asinList || json.asins || [];

  return asins.slice(0, limit);
}

function fetchKeepaProducts_(apiKey, asins, tokenGuard) {
  const products = [];
  const chunkSize = 100;

  for (let i = 0; i < asins.length && !(tokenGuard && tokenGuard.stopReason); i += chunkSize) {
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

    if (code === 429) {
      throw createKeepaGracefulStop_('Keepa token/API limit stop: HTTP 429 on product fetch.');
    }

    if (code < 200 || code >= 300) {
      Utilities.sleep(15000);
      throw new Error(`Keepa product fetch failed HTTP ${code}: ${text.slice(0, 250)}`);
    }

    const json = JSON.parse(text);

    if (json.error) {
      if (isKeepaTokenLimitError_(json.error)) {
        throw createKeepaGracefulStop_(`Keepa token/API limit stop: ${json.error.message || JSON.stringify(json.error)}`);
      }
      Utilities.sleep(15000);
      throw new Error(`Keepa product error: ${json.error.message || JSON.stringify(json.error)}`);
    }

    updateKeepaTokenGuard_(tokenGuard, json, 'Keepa tokens below KEEPA_MIN_TOKENS_TO_CONTINUE after product fetch');

    (json.products || []).forEach(p => products.push(p));

    Utilities.sleep(1500);
  }

  return products;
}

function updateKeepaTokenGuard_(tokenGuard, json, message) {
  if (!tokenGuard || !json) return;

  const tokensLeft = getKeepaTokensLeft_(json);
  if (tokensLeft === '') return;

  tokenGuard.tokensLeft = tokensLeft;
  if (tokensLeft < tokenGuard.minTokensToContinue && !tokenGuard.stopReason) {
    tokenGuard.stopReason = `${message}: ${tokensLeft}/${tokenGuard.minTokensToContinue}.`;
  }
}

function getKeepaTokensLeft_(json) {
  const candidates = [
    json.tokensLeft,
    json.tokensleft,
    json.tokenLeft,
    json.tokenBalance,
    json.tokens
  ];

  for (let i = 0; i < candidates.length; i++) {
    const value = candidates[i];
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (isFinite(n)) return n;
  }

  return '';
}

function createKeepaGracefulStop_(message) {
  const err = new Error(message);
  err.keepaGracefulStop = true;
  return err;
}

function isKeepaGracefulStop_(err) {
  return Boolean(err && err.keepaGracefulStop);
}

function isKeepaTokenLimitError_(error) {
  const text = normalize_(error && (error.message || error.type || JSON.stringify(error)));
  return /token|throttle|rate limit|too many requests|429/.test(text);
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
    'Keepa Opportunity Score',
    'Keepa Profit Signal',
    'Keepa Margin Signal',
    'Keepa Velocity Signal',
    'Keepa Risk Signal',
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

function appendDailyKeepaPull_(ss, products, options) {
  const sheet = getOrCreateSheet_(ss, SHEETS.DAILY_KEEPA_PULL);
  setupDailyKeepaHeaders_(ss);

  const appendLimit = options && options.appendLimit ? Number(options.appendLimit) : products.length;
  const selection = selectKeepaProductsForAppend_(ss, products, appendLimit, PropertiesService.getScriptProperties());
  const rows = selection.rows;

  if (!rows.length) {
    const logSheet = getOrCreateSheet_(ss, SHEETS.RUN_LOG);
    log_(logSheet, 'No new ASINs/UPCs to append after dedupe, brand diversity, and opportunity filtering');
    return selection;
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

  sheet.getRange(2, 9, Math.max(1, sheet.getLastRow() - 1), 3).setNumberFormat('$#,##0.00');
  sheet.getRange(2, 17, Math.max(1, sheet.getLastRow() - 1), 2).setNumberFormat('0.0%');
  sheet.autoResizeColumns(1, 27);

  const logSheet = getOrCreateSheet_(ss, SHEETS.RUN_LOG);
  log_(logSheet, `Appended ${rows.length} new products to Daily Keepa Pull`);
  return selection;
}

function selectKeepaProductsForAppend_(ss, products, appendLimit, props) {
  const maxPerBrand = getPositiveIntegerProperty_(props, 'KEEPA_MAX_NEW_PRODUCTS_PER_BRAND', 5);
  const existingProductKeys = getExistingProductKeysAcrossSheets_(ss, [
    SHEETS.DAILY_KEEPA_PULL,
    SHEETS.SOURCE_LINK_FINDER,
    SHEETS.SOURCE_LINK_FINDER_ARCHIVE,
    SHEETS.SOURCE_SEARCH_QUEUE,
    SHEETS.SOURCE_MATCHES
  ]);
  const seenAsins = new Set();
  const seenUpcs = new Set();
  const byBrand = {};
  const stats = {
    rows: [],
    evaluated: 0,
    opportunityPasses: 0,
    duplicateSkips: 0,
    weakSkips: 0,
    brandCapSkips: 0,
    topCappedBrands: '',
    appended: 0
  };

  products.forEach(product => {
    stats.evaluated++;
    const asin = String(product.asin || '').trim();
    const upc = getUpc_(product);

    if (!asin || seenAsins.has(asin) || existingProductKeys.asins.has(asin) || (upc && (seenUpcs.has(upc) || existingProductKeys.upcs.has(upc)))) {
      stats.duplicateSkips++;
      return;
    }

    seenAsins.add(asin);
    if (upc) seenUpcs.add(upc);

    const opportunity = evaluateKeepaIngestOpportunity_(product);
    if (!opportunity.eligible) {
      stats.weakSkips++;
      return;
    }

    stats.opportunityPasses++;
    const brandKey = normalizeBrandKey_(product.brand);
    if (!byBrand[brandKey]) byBrand[brandKey] = [];
    byBrand[brandKey].push({ product, opportunity });
  });

  const cappedBrandSkips = {};
  const selected = [];
  Object.keys(byBrand).forEach(brandKey => {
    const candidates = byBrand[brandKey].sort((a, b) => b.opportunity.score - a.opportunity.score);
    const keep = candidates.slice(0, maxPerBrand);
    selected.push.apply(selected, keep);
    if (candidates.length > maxPerBrand) cappedBrandSkips[brandKey] = candidates.length - maxPerBrand;
  });

  selected
    .sort((a, b) => b.opportunity.score - a.opportunity.score)
    .slice(0, appendLimit)
    .forEach(item => stats.rows.push(buildKeepaRow_(item.product, item.opportunity)));

  const selectedByBrand = {};
  stats.rows.forEach(row => {
    const brandKey = normalizeBrandKey_(row[3]);
    selectedByBrand[brandKey] = (selectedByBrand[brandKey] || 0) + 1;
  });
  Object.keys(selectedByBrand).forEach(brandKey => {
    const overflow = Math.max(0, (byBrand[brandKey] || []).length - selectedByBrand[brandKey]);
    if (overflow) cappedBrandSkips[brandKey] = Math.max(cappedBrandSkips[brandKey] || 0, overflow);
  });

  stats.appended = stats.rows.length;
  stats.brandCapSkips = Object.keys(cappedBrandSkips).reduce((sum, brand) => sum + cappedBrandSkips[brand], 0);
  stats.topCappedBrands = formatTopCappedBrands_(cappedBrandSkips);
  return stats;
}

function evaluateKeepaIngestOpportunity_(product) {
  const stats = product.stats || {};
  const title = product.title || '';
  const brand = product.brand || '';
  const likelySellPrice = centsToDollars_(getStatValue_(stats.current, 18)) || centsToDollars_(getStatValue_(stats.avg90, 18));
  const lowestFba = centsToDollars_(getStatValue_(stats.current, 10));
  const maxBuyCost = likelySellPrice ? round_(likelySellPrice * 0.7 - 2, 2) : 0;
  const expectedProfit = lowestFba && maxBuyCost ? round_(lowestFba - maxBuyCost, 2) : (maxBuyCost ? 2 : 0);
  const margin = likelySellPrice && expectedProfit ? expectedProfit / likelySellPrice : null;
  const monthlySales = Number(product.monthlySold || product.monthlySoldHistory || 0);
  const rankDrops30 = Number(product.salesRankDrops30 || 0);
  const hasVelocityData = monthlySales > 0 || rankDrops30 > 0;
  const velocityStrong = monthlySales >= 50 || rankDrops30 >= 10 || !hasVelocityData;
  const marginOk = margin === null || margin >= 0.15;
  const profitOk = expectedProfit >= 2;
  const allowedProduct = !isRiskyProduct_(title, brand);
  const riskAllowed = !isRestrictedKeepaBrand_(brand, product);
  const titleQualityScore = getKeepaTitleQualityScore_(title);
  const baseScore = scoreOpportunity_({
    monthlySales,
    rankDrops30,
    newOfferCount: getStatValue_(stats.current, 11) || 0,
    fbaOfferCount: getFbaOfferCount_(product),
    amazonOosPct: 0,
    aboveBuyBoxSpread: lowestFba && likelySellPrice ? lowestFba - likelySellPrice : 0,
    likelySellPrice
  });
  const score = Math.max(0, Math.min(100, round_(
    baseScore +
    (maxBuyCost ? 10 : -25) +
    (likelySellPrice ? 10 : -25) +
    (profitOk ? 20 : -20) +
    (marginOk ? 15 : -15) +
    (velocityStrong ? 10 : -15) +
    titleQualityScore +
    (riskAllowed && allowedProduct ? 5 : -35),
    1
  )));

  return {
    eligible: Boolean(maxBuyCost && likelySellPrice && marginOk && profitOk && velocityStrong && allowedProduct && riskAllowed),
    score,
    maxBuyCost,
    expectedProfit,
    margin,
    profitSignal: buildKeepaProfitSignal_(maxBuyCost, expectedProfit),
    marginSignal: buildKeepaMarginSignal_(margin),
    velocitySignal: buildVelocitySignal_({ monthlySales, salesRankDrops: rankDrops30 }),
    riskSignal: buildKeepaRiskSignal_(allowedProduct, riskAllowed, titleQualityScore)
  };
}

function buildKeepaProfitSignal_(maxBuyCost, expectedProfit) {
  if (!maxBuyCost) return 'No max buy cost signal';
  if (expectedProfit === '' || expectedProfit === null || expectedProfit === undefined) return `Max buy cost $${maxBuyCost.toFixed(2)}`;
  return expectedProfit >= 2
    ? `Profit >= $2 ($${expectedProfit.toFixed(2)}); max buy $${maxBuyCost.toFixed(2)}`
    : `Profit below $2 ($${expectedProfit.toFixed(2)}); max buy $${maxBuyCost.toFixed(2)}`;
}

function buildKeepaMarginSignal_(margin) {
  if (margin === null || margin === undefined || margin === '') return 'Margin not calculable';
  return margin >= 0.15
    ? `Margin ${(margin * 100).toFixed(0)}%`
    : `Margin below 15% (${(margin * 100).toFixed(0)}%)`;
}

function buildKeepaRiskSignal_(allowedProduct, riskAllowed, titleQualityScore) {
  const parts = [];
  parts.push(allowedProduct ? 'Allowed product' : 'Risky product/category');
  parts.push(riskAllowed ? 'No brand restriction signal' : 'Brand/risk restriction signal');
  if (titleQualityScore < 0) parts.push('Weak title quality');
  return parts.join('; ');
}

function getKeepaTitleQualityScore_(title) {
  const normalizedTitle = normalize_(title);
  if (!normalizedTitle) return -20;
  let score = Math.min(10, normalizedTitle.length / 12);
  if (/bundle|lot of|mystery|unknown|damaged|parts only/.test(normalizedTitle)) score -= 10;
  return score;
}

function isRestrictedKeepaBrand_(brand, product) {
  const riskText = normalize_([
    brand,
    product && product.brandRisk,
    product && product.restriction,
    product && product.restricted,
    product && product.isHazMat,
    product && product.isAdultProduct
  ].join(' '));
  return /restricted|hazmat|adult|dangerous|gated/.test(riskText);
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

function getExistingAsinsAcrossSheets_(ss, sheetNames) {
  return getExistingProductKeysAcrossSheets_(ss, sheetNames).asins;
}

function getExistingProductKeysAcrossSheets_(ss, sheetNames) {
  const keys = {
    asins: new Set(),
    upcs: new Set()
  };

  sheetNames.forEach(sheetName => {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    getExistingAsins_(sheet).forEach(asin => keys.asins.add(asin));
    getExistingUpcs_(sheet).forEach(upc => keys.upcs.add(upc));
  });

  return keys;
}

function getExistingUpcs_(sheet) {
  const lastRow = sheet.getLastRow();
  const set = new Set();

  if (lastRow < 2 || sheet.getLastColumn() < 5) return set;

  const values = sheet.getRange(2, 5, lastRow - 1, 1).getValues();

  values.forEach(row => {
    if (row[0]) set.add(String(row[0]).trim());
  });

  return set;
}

function buildKeepaRow_(product, opportunity) {
  const asin = product.asin || '';
  const stats = product.stats || {};
  const keepaOpportunity = opportunity || evaluateKeepaIngestOpportunity_(product);

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

  const opportunityScore = keepaOpportunity.score;
  const status = keepaOpportunity.eligible ? 'QUALIFIED' : 'REVIEW';

  const notes = [];

  if (Number(fbaOfferCount) <= 5 && fbaOfferCount !== '') notes.push('Low FBA competition');
  if (Number(monthlySales) >= 100) notes.push('Demand signal');
  if (Number(rankDrops30) >= 15) notes.push('Sales-rank movement');
  if (keepaOpportunity.maxBuyCost) notes.push(`Estimated max buy cost: $${keepaOpportunity.maxBuyCost.toFixed(2)}`);

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
    keepaOpportunity.profitSignal,
    keepaOpportunity.marginSignal,
    keepaOpportunity.velocitySignal,
    keepaOpportunity.riskSignal,
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


function getFinderProductRowStats_(sheet) {
  const lastRow = sheet.getLastRow();
  const stats = {
    activeProductRows: 0,
    emptyProductRows: []
  };

  if (lastRow < 2) return stats;

  const columnCount = Math.min(Math.max(20, sheet.getLastColumn()), sheet.getMaxColumns());
  const values = sheet.getRange(2, 1, lastRow - 1, columnCount).getValues();

  values.forEach((row, index) => {
    const rowNumber = index + 2;
    if (rowHasProductIdentity_(row) && !hasApprovedMoveDecision_(row) && !hasRejectedMoveDecision_(row) && !hasClearFinalRejectedDecision_(row)) {
      stats.activeProductRows++;
    } else if (!rowHasProductIdentity_(row)) {
      stats.emptyProductRows.push(rowNumber);
    }
  });

  return stats;
}

function writeRowsToFinderProductSlots_(sheet, rows, emptyProductRows, columnCount) {
  let appendRow = sheet.getLastRow() + 1;

  rows.forEach((row, index) => {
    const targetRow = emptyProductRows[index] || appendRow++;
    sheet.getRange(targetRow, 1, 1, columnCount).setValues([row]);
  });
}

function getActiveFinderBrandCounts_(sheet) {
  const lastRow = sheet.getLastRow();
  const counts = {};

  if (lastRow < 2) return counts;

  const columnCount = Math.min(Math.max(20, sheet.getLastColumn()), sheet.getMaxColumns());
  const values = sheet.getRange(2, 1, lastRow - 1, columnCount).getValues();

  values.forEach(row => {
    if (!rowHasProductIdentity_(row)) return;
    if (hasApprovedMoveDecision_(row) || hasRejectedMoveDecision_(row) || hasClearFinalRejectedDecision_(row)) return;

    const brandKey = normalizeBrandKey_(row[3]);
    counts[brandKey] = (counts[brandKey] || 0) + 1;
  });

  return counts;
}

function rowHasProductIdentity_(row) {
  return Boolean(String(row[1] || '').trim() || String(row[2] || '').trim());
}

function hasApprovedMoveDecision_(row) {
  return normalize_(row[18]) === 'yes'; // S
}

function hasRejectedMoveDecision_(row) {
  return normalize_(row[18]) === 'no'; // S
}

function hasReviewMoveDecision_(row) {
  return normalize_(row[18]) === 'review'; // S
}

function hasSkipSearchStatus_(row) {
  return normalize_(row[22]) === 'skip'; // W
}

function hasStaleReviewDecision_(row, reviewMaxAgeDays) {
  if (normalize_(row[18]) !== 'review') return false;

  const lastChecked = row[29]; // AD
  if (!(lastChecked instanceof Date)) return false;

  const ageMs = new Date().getTime() - lastChecked.getTime();
  return ageMs > reviewMaxAgeDays * 24 * 60 * 60 * 1000;
}

function hasClearFinalRejectedDecision_(row) {
  const finalRejectedValues = {
    no: true,
    reject: true,
    rejected: true,
    skip: true,
    'not viable': true
  };
  const decisionCells = row.slice(14, 20); // O:T

  return decisionCells.some(value => finalRejectedValues[normalize_(value)] === true);
}

function ensureSheetColumns_(sheet, sourceColumnCount) {
  if (sheet.getMaxColumns() < sourceColumnCount) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), sourceColumnCount - sheet.getMaxColumns());
  }
}

function ensureDestinationSheetHeaders_(sourceSheet, destinationSheet, sourceColumnCount) {
  if (destinationSheet.getLastRow() > 0) return;

  const headers = sourceSheet.getRange(1, 1, 1, sourceColumnCount).getValues();
  destinationSheet.getRange(1, 1, 1, sourceColumnCount).setValues(headers);
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

function getQualifiedSheet_(ss, logSheet) {
  const qualifiedSheet = ss.getSheetByName(SHEETS.QUALIFIED);
  const legacySheet = ss.getSheetByName(SHEETS.QUALIFIED_LEGACY);

  if (qualifiedSheet) {
    if (legacySheet && logSheet) {
      log_(logSheet, `Qualified tab migration skipped: both "${SHEETS.QUALIFIED}" and legacy "${SHEETS.QUALIFIED_LEGACY}" exist. No data changed.`);
    }
    return qualifiedSheet;
  }

  if (legacySheet) {
    legacySheet.setName(SHEETS.QUALIFIED);
    if (logSheet) {
      log_(logSheet, `Renamed legacy "${SHEETS.QUALIFIED_LEGACY}" tab to "${SHEETS.QUALIFIED}" without changing row data.`);
    }
    return legacySheet;
  }

  return getOrCreateSheet_(ss, SHEETS.QUALIFIED);
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
