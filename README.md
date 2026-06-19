# KeepaAutomation

Automate product discovery for Hidden Gems LLC.

## Source Link Finder brand diversity controls

The queue refill step moves products from `Source Search Queue` into `Source Link Finder` while keeping the current default `Source Link Finder` target at **500 rows**. To prevent one or two brands from crowding out everything else, the refill now enforces a per-brand active-row cap before moving more queue rows.

By default, no more than **5 active rows per brand** are kept in `Source Link Finder`. This improves sourcing diversity for brands such as Carhartt, EcoNour, PartyWoo, Ailun, Owala, Apple, and any other brand that may dominate the queue.

This control only changes which queued rows are moved into `Source Link Finder`. It does **not** call Keepa and does **not** increase Keepa API usage.

### New script properties

| Property | Default | Purpose |
| --- | ---: | --- |
| `SOURCE_LINK_FINDER_MAX_PER_BRAND` | `5` | Maximum active rows from the same brand allowed in `Source Link Finder`. Increase this if you want deeper coverage for repeated brands; decrease it for broader brand diversity. |
| `SOURCE_QUEUE_SCAN_LIMIT` | `1000` | Maximum number of `Source Search Queue` rows scanned per refill run. Increase this if the queue is very brand-heavy and the refill needs to look deeper to find uncapped brands; decrease it if runs are taking too long. |
| `SOURCE_LINK_FINDER_TARGET_ROWS` | `500` | Target number of real product rows to keep in `Source Link Finder`; blank or formula-only rows do not count toward this capacity. |

`SOURCE_LINK_FINDER_TARGET_ROWS` remains optional and defaults to `500`. If `SOURCE_LINK_FINDER_BATCH_LIMIT` is set, it still limits how many rows can move in one run.

### How skipped rows are handled

Rows skipped because their brand is already capped are left in `Source Search Queue` for future runs. The script does not overwrite core product data for skipped rows. Once active rows for that brand in `Source Link Finder` receive a clear final `No` or `Reject` status in the O:T decision columns, future refill runs can move more rows for that brand.

If a row's final status is ambiguous, it is counted as active. This conservative behavior prevents uncertain rows from bypassing the brand cap.

### Run Log verification

After running `moveSourceSearchQueueToSourceLinkFinder()` or its alias `refillSourceLinkFinderFromQueue()`, check `Run Log` for entries showing:

- active product rows counted, target capacity, and available slots
- rows moved to `Source Link Finder`
- rows skipped due to brand cap
- top capped brands
- whether the queue scan limit was reached
- any duplicate ASIN skips from existing dedupe behavior
