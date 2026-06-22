# KeepaAutomation

Automate product discovery and sourcing for Hidden Gems LLC.

## Automated sourcing workflow

The sourcing pipeline is designed to run without using `Source Link Finder` as a capped manual review queue:

`Daily Keepa Pull` → `Qualified` → `Source Link Finder` processing → winners to `Source Matches` → losers/errors to `Source Link Finder Archive`

`Qualified` means all viable products that meet the automation criteria. It is not capped at 2,000 products. If an older workbook still has a `Qualified 2,000` tab, the script safely renames it to `Qualified` when it can do so without data loss; if both tabs exist, it leaves both in place and logs that no data was changed.

Use `runAutomatedSourcingPipeline()` for the end-to-end sourcing pass. It runs these steps in order:

1. `moveApprovedSourceMatches()` moves rows where column S is `Yes` from `Source Link Finder` to `Source Matches`.
2. `cleanupSourceLinkFinderRejectedRows()` archives rejected, skipped, not-viable, or stale review rows.
3. `moveQualifiedRowsToSourceLinkFinder()` moves the next eligible batch from `Qualified` into `Source Link Finder`.
4. `runSerpApiSourceFinder()` searches eligible rows and writes final decisions into columns O:T.
5. `moveApprovedSourceMatches()` moves newly approved winners to `Source Matches`.
6. `cleanupSourceLinkFinderRejectedRows()` archives newly rejected losers and errors.

`Source Link Finder` is a temporary processing workspace. It is **not** capped by total row count and should not be treated as a manual review queue. `Source Search Queue` may still exist for legacy/internal staging, but the active user workflow no longer depends on it and new raw Keepa products are not inserted there.

## Automated decisions

SerpApi processing writes decisions into columns O:T for every searched row:

- High-confidence profitable source matches are marked `Yes`.
- Medium-confidence profitable source matches are marked `Yes`.
- Low-confidence matches are marked `No` unless the row is promising but missing enough data to justify a short `Review` hold.
- SerpApi searches use product title/name first, then brand plus a shortened title when needed. UPC/GTIN is used after results return as a validation signal, with UPC fallback only after product-name searches fail to produce a credible match.
- No source found, source price above Max Buy Cost, risky sources, risky products, gift cards, subscriptions, renewed/refurbished electronics, and Amazon-to-Amazon resale are marked `No`.
- Search errors are marked `No` with concise notes so O:T is not left blank.

Rows marked `Yes` are moved to `Source Matches`; rows marked `No`, `Reject`, `Skip`, `Not viable`, or other clear final rejected decisions are preserved in `Source Link Finder Archive` and deleted from the processing workspace.

## Opportunity scoring columns

`setupSerpApiColumns()` adds or repairs the SerpApi and opportunity columns on `Source Link Finder`:

| Column | Purpose |
| --- | --- |
| `Opportunity Score` | 0-100 sourcing score based on profit, margin, velocity, match quality, and retailer/product risk. |
| `Profit Signal` | Expected-profit threshold signal, including whether expected profit is at least $2. |
| `Margin Signal` | Margin threshold signal, including whether margin is at least 15%. |
| `Velocity Signal` | Sales velocity context from monthly sales and sales-rank drops when available. |
| `Match Signal` | UPC, brand, title-overlap, retailer-legitimacy, and product-risk summary. |

Source scoring happens later, after a source URL and source price are found. It still evaluates retailer legitimacy, match confidence, UPC/brand/title alignment, product risk, and profitability against Max Buy Cost. Keepa pre-ingestion scoring does not depend on source URL or source price because those values are not known yet.

## Daily Keepa Pull brand diversity

`runKeepaHourlyScan()` applies pre-ingestion scoring and brand diversity before rows are written to `Daily Keepa Pull`. Keepa candidates are deduped by ASIN/UPC across the workbook, scored using only available Keepa/product data, screened for profitability, velocity, product-quality, competition/stock, and sourceability/risk signals, then grouped by normalized brand so one brand cannot consume the whole hourly batch.

Only products with `Keepa Opportunity Score >= 70`, estimated profit of at least `$2`, and estimated margin of at least `15%` are eligible to move forward. The Keepa score is weighted as velocity `30%`, profit `25%`, margin `20%`, competition/stock `15%`, and sourceability/match likelihood `10%`. Brand diversity is applied after the product passes these gates.

Brand diversity is a discovery control only: it does **not** override profitability or velocity requirements. Weak products, duplicates, products without a likely sell price / max-buy-cost potential, products below the estimated 15% margin or $2 profit thresholds, weak or missing velocity candidates, overly competitive products when offer-count data is available, gift cards, subscriptions, apps/downloads, renewed/refurbished phones/electronics, carrier-locked devices, Amazon-to-Amazon resale dependencies, questionable sourceability signals, and restricted/risky brands are skipped before any brand slot is consumed.

`KEEPA_MAX_NEW_PRODUCTS_PER_BRAND` means no more than 5 viable new products per normalized brand are appended per Keepa run by default. Duplicate or weak products do not count toward the 5. Once 5 viable products are selected for a brand, additional products from that brand are skipped and the scan continues looking for other brands while the scan and token guard allow it.

If the current Keepa query page is dominated by brands or product families that already exist in the active pipeline, the scanner can continue into deeper Keepa query pages until it appends the hourly target, reaches the diversity scan limit, receives an empty ASIN response, or stops because Keepa/API behavior or token availability would require additional unexpected calls. Before a product enters `Daily Keepa Pull`, the scanner skips duplicate ASIN/UPC history across `Daily Keepa Pull`, `Qualified`, `Source Link Finder`, `Source Matches`, `Source Link Finder Archive`, and `Rejected Archive` when present. It also applies rolling active-pipeline caps across `Daily Keepa Pull`, `Qualified`, `Source Link Finder`, and `Source Matches` so repeat-heavy brands and narrow product families stop re-entering intake.

The scanner uses `KEEPA_QUERY_PAGE` as a forward-only page cursor: each run starts from the stored page and saves the next page after the last attempted page. It does not wrap back to page 0 because of a fixed max page cap. It resets to page 0 only when `KEEPA_SELECTION_JSON` changes or `resetKeepaRotation()` is run manually. Run Log entries include starting page, page numbers scanned, number of pages scanned, next page saved, whether selection JSON reset the cursor, products scanned, profit/margin/velocity/competition/sourceability/score rejections, candidates deduped, rolling brand/category cap skips, top skipped brands/categories, candidates passing pre-ingestion score, candidates skipped as weak, qualified products inserted, brand-cap skips, selected count by brand, token-limit stop/warning, no-ASIN status, and whether deeper page scanning was used.

`Source Link Finder` should only receive pre-qualified Keepa rows. During queue refill, Keepa-shaped rows from `Source Search Queue` are allowed through only when they still show `Keepa Opportunity Score >= 70` and `Status = QUALIFIED`; duplicate ASIN/UPC rows are removed, while rows skipped only because of the active Source Link Finder brand cap remain queued for a later pass.

`Daily Keepa Pull` includes Keepa-specific scoring fields:

| Column | Purpose |
| --- | --- |
| `Keepa Opportunity Score` | 0-100 pre-ingestion score from available Keepa/product signals. |
| `Keepa Profit Signal` | Max-buy-cost and estimated-profit threshold context. |
| `Keepa Margin Signal` | Estimated margin threshold context when calculable. |
| `Keepa Velocity Signal` | Monthly sales and sales-rank-drop context when available. |
| `Keepa Risk Signal` | Product/category, brand restriction, and title-quality risk context. |

`Qualified` and `Source Search Queue` use the Source Link Finder-compatible row shape and include trailing `Estimated Profit` and `Estimated Margin` columns so acceptance checks can verify the numeric thresholds directly before rows reach `Source Link Finder`.

## Tuning script properties

| Property | Default | Purpose |
| --- | ---: | --- |
| `KEEPA_MAX_NEW_PRODUCTS_PER_BRAND` | `5` | Maximum new Daily Keepa Pull products appended per normalized brand per Keepa scan run, after dedupe and opportunity filtering. |
| `KEEPA_ROLLING_BRAND_CAP` | `5` | Maximum active products per normalized brand across `Daily Keepa Pull`, `Qualified`, `Source Link Finder`, and `Source Matches`. |
| `KEEPA_ROLLING_CATEGORY_CAP` | `10` | Maximum active products per normalized narrow category/product family across the active pipeline. |
| `KEEPA_QUERY_PAGE` | `0` | Forward-only Keepa page cursor for the next hourly scan. Use `setNextKeepaPageTo40()` to start the next run at page 40, or `resetKeepaRotation()` to reset to page 0. |
| `KEEPA_BRAND_DIVERSITY_SCAN_LIMIT` | `250` | Maximum Keepa candidates evaluated per run while searching deeper pages for qualified, diverse products. |
| `KEEPA_MIN_TOKENS_TO_CONTINUE` | `50` | Minimum Keepa token balance required before deeper scanning continues. Low tokens or HTTP 429 stops the scan gracefully and logs a warning. |
| `SOURCE_LINK_FINDER_BATCH_LIMIT` | `100` | Maximum eligible rows moved from `Source Search Queue` into `Source Link Finder` per refill run. This is a per-run batch limit, not a total Source Link Finder cap. |
| `SOURCE_QUEUE_SCAN_LIMIT` | `1000` | Maximum Source Search Queue rows scanned per refill run so brand-heavy queues do not scan forever. |
| `SOURCE_LINK_FINDER_MAX_PER_BRAND` | `5` | Maximum active rows per brand in `Source Link Finder`; approved/rejected rows are moved/archived before brand counts are calculated. |
| `SOURCE_REVIEW_MAX_AGE_DAYS` | `2` | Maximum age for rare `Review` rows before cleanup archives them unless they are marked `Yes`. |
| `SERPAPI_DAILY_CAP` | `8` | Maximum SerpApi searches per day. |
| `SERPAPI_MONTHLY_CAP` | `240` | Maximum SerpApi searches per month. |

`SOURCE_LINK_FINDER_TARGET_ROWS` is no longer used. Total `Source Link Finder` row count does not block refills or processing.

## Run Log verification

Check `Run Log` after `runAutomatedSourcingPipeline()` or individual steps. Expected entries include:

- rows moved into `Source Link Finder`
- starting Keepa page, pages scanned, and next page saved
- rolling brand/category cap skips and top skipped brands/categories
- rows searched
- SerpApi query strategy
- rows auto-approved `Yes`
- rows auto-rejected `No`
- rows left `Review`
- rows moved to `Source Matches`
- rows archived
- brand-cap skips
- duplicate ASIN/UPC skips
- errors or retry/rejection notes
