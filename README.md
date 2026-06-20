# KeepaAutomation

Automate product discovery and sourcing for Hidden Gems LLC.

## Automated sourcing workflow

The sourcing pipeline is designed to run without using `Source Link Finder` as a capped manual review queue:

`Daily Keepa Pull` → `Qualified` → `Source Search Queue` → `Source Link Finder` processing → winners to `Source Matches` → losers/errors to `Source Link Finder Archive`

`Qualified` means all viable products that meet the automation criteria. It is not capped at 2,000 products. If an older workbook still has a `Qualified 2,000` tab, the script safely renames it to `Qualified` when it can do so without data loss; if both tabs exist, it leaves both in place and logs that no data was changed.

Use `runAutomatedSourcingPipeline()` for the end-to-end sourcing pass. It runs these steps in order:

1. `moveApprovedSourceMatches()` moves rows where column S is `Yes` from `Source Link Finder` to `Source Matches`.
2. `cleanupSourceLinkFinderRejectedRows()` archives rejected, skipped, not-viable, or stale review rows.
3. `moveSourceSearchQueueToSourceLinkFinder()` moves the next eligible batch from `Source Search Queue` into `Source Link Finder`.
4. `runSerpApiSourceFinder()` searches eligible rows and writes final decisions into columns O:T.
5. `moveApprovedSourceMatches()` moves newly approved winners to `Source Matches`.
6. `cleanupSourceLinkFinderRejectedRows()` archives newly rejected losers and errors.

`Source Link Finder` is a temporary processing workspace. It is **not** capped by total row count and should not be treated as a manual review queue.

## Automated decisions

SerpApi processing writes decisions into columns O:T for every searched row:

- High-confidence profitable source matches are marked `Yes`.
- Medium-confidence profitable source matches are marked `Yes`.
- Low-confidence matches are marked `No` unless the row is promising but missing enough data to justify a short `Review` hold.
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

`runKeepaHourlyScan()` applies pre-ingestion scoring and brand diversity before rows are written to `Daily Keepa Pull`. Keepa candidates are deduped by ASIN/UPC across the workbook, scored using only available Keepa/product data, screened for profitability, velocity, product-quality, and risk signals, then grouped by normalized brand so one brand cannot consume the whole hourly batch.

Brand diversity is a discovery control only: it does **not** override profitability or velocity requirements. Weak products, duplicates, products without a likely sell price / max-buy-cost potential, products below the estimated 15% margin or $2 profit thresholds when calculable, weak velocity candidates, gift cards, subscriptions, apps/downloads, renewed/refurbished electronics, and restricted/risky brands are skipped before any brand slot is consumed.

`KEEPA_MAX_NEW_PRODUCTS_PER_BRAND` means no more than 5 viable new products per normalized brand are appended per Keepa run by default. Duplicate or weak products do not count toward the 5. Once 5 viable products are selected for a brand, additional products from that brand are skipped and the scan continues looking for other brands while the scan and token guard allow it.

If the current Keepa query page is dominated by brands that have already hit the per-run cap, the scanner can continue into deeper Keepa query pages until it appends the hourly target, reaches the diversity scan limit, or stops because Keepa/API behavior or token availability would require additional unexpected calls. Run Log entries include candidates fetched/evaluated, candidates deduped, candidates passing pre-ingestion score, candidates skipped as weak, products appended, brand-cap skips, top capped brands, token-limit stop/warning, and whether deeper page scanning was used.

`Daily Keepa Pull` includes Keepa-specific scoring fields:

| Column | Purpose |
| --- | --- |
| `Keepa Opportunity Score` | 0-100 pre-ingestion score from available Keepa/product signals. |
| `Keepa Profit Signal` | Max-buy-cost and estimated-profit threshold context. |
| `Keepa Margin Signal` | Estimated margin threshold context when calculable. |
| `Keepa Velocity Signal` | Monthly sales and sales-rank-drop context when available. |
| `Keepa Risk Signal` | Product/category, brand restriction, and title-quality risk context. |

## Tuning script properties

| Property | Default | Purpose |
| --- | ---: | --- |
| `KEEPA_MAX_NEW_PRODUCTS_PER_BRAND` | `5` | Maximum new Daily Keepa Pull products appended per normalized brand per Keepa scan run, after dedupe and opportunity filtering. |
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
- rows searched
- rows auto-approved `Yes`
- rows auto-rejected `No`
- rows left `Review`
- rows moved to `Source Matches`
- rows archived
- brand-cap skips
- duplicate ASIN/UPC skips
- errors or retry/rejection notes
