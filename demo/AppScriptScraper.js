

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL    = "https://manila.craigslist.org";
const SEARCH_URL  = "https://manila.craigslist.org/search/rea";
const SHEET_NAME  = "Craigslist Listings";
const MAX_PAGES   = 3;       // each page = 120 listings
const DELAY_MS    = 2000;    // 2 sec between requests — be polite

// ── Main Entry Point ──────────────────────────────────────────────────────────
function scrapeCraigslist() {
  const sheet    = getOrCreateSheet(SHEET_NAME);
  const listings = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    // Craigslist paginates with ?s=0, ?s=120, ?s=240 ...
    const url  = SEARCH_URL + (page > 0 ? `?s=${page * 120}` : "");
    Logger.log(`Fetching page ${page + 1}: ${url}`);

    const html = fetchPage(url);
    if (!html) {
      Logger.log("Fetch failed — stopping.");
      break;
    }

    const pageListings = parseListings(html);
    if (pageListings.length === 0) {
      Logger.log("No listings found on this page — stopping.");
      break;
    }

    listings.push(...pageListings);
    Logger.log(`Page ${page + 1}: found ${pageListings.length} listings (total: ${listings.length})`);

    if (page < MAX_PAGES - 1) Utilities.sleep(DELAY_MS);
  }

  if (listings.length > 0) {
    writeToSheet(sheet, listings);
    SpreadsheetApp.getUi().alert(`✅ Done! Scraped ${listings.length} listings.`);
  } else {
    Logger.log("⚠️ No listings scraped. Check logs.");
    SpreadsheetApp.getUi().alert("⚠️ No listings found. Check the Apps Script logs.");
  }
}

// ── Fetch Page ────────────────────────────────────────────────────────────────
function fetchPage(url) {
  try {
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      followRedirects: true,
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      Logger.log(`HTTP ${code} returned from ${url}`);
      return null;
    }

    return response.getContentText();
  } catch (e) {
    Logger.log(`Fetch error: ${e.message}`);
    return null;
  }
}

// ── Parse Listings ────────────────────────────────────────────────────────────
/**
 * Craigslist search results HTML structure (new design):
 *
 * <li class="cl-static-search-result">
 *   <a href="/reb/d/listing-title/1234567890.html">
 *     <div class="title">Listing Title</div>
 *     <div class="price">₱1,500,000</div>
 *     <div class="location">Quezon City</div>
 *   </a>
 * </li>
 */
function parseListings(html) {
  const listings = [];

  // ── Strategy 1: New Craigslist design (cl-static-search-result) ──
  // Match each listing block
  const blockRegex = /<li[^>]*class="[^"]*cl-static-search-result[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const block = blockMatch[1];
    listings.push({
      title:    extractTag(block, "title")    || extractTag(block, "titlestring"),
      price:    extractTag(block, "price"),
      location: extractTag(block, "location"),
      url:      BASE_URL + extractHref(block),
      scraped:  new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" }),
    });
  }

  // ── Strategy 2: Fallback — older Craigslist design ──
  // Used if Strategy 1 returns nothing
  if (listings.length === 0) {
    const rowRegex = /<li[^>]*class="[^"]*result-row[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(html)) !== null) {
      const row = rowMatch[1];
      listings.push({
        title:    extractAttr(row, "result-title", "title") || extractTag(row, "result-title"),
        price:    extractTag(row, "result-price"),
        location: extractTag(row, "result-hood"),
        url:      BASE_URL + extractHref(row),
        scraped:  new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" }),
      });
    }
  }

  // Filter out empty rows
  return listings.filter(l => l.title && l.title.trim() !== "");
}

// ── Regex Helpers ─────────────────────────────────────────────────────────────

// Get text content inside a class: <div class="price">₱1,000</div> → "₱1,000"
function extractTag(html, className) {
  const re = new RegExp(`class="${className}"[^>]*>([^<]+)<`, "i");
  const m  = html.match(re);
  return m ? m[1].trim() : "";
}

// Get an attribute value: <a title="My Listing" ...> → "My Listing"
function extractAttr(html, className, attr) {
  const re = new RegExp(`class="${className}"[^>]*${attr}="([^"]+)"`, "i");
  const m  = html.match(re);
  return m ? m[1].trim() : "";
}

// Get href from first <a> tag in the block
function extractHref(html) {
  const m = html.match(/href="([^"]+)"/i);
  return m ? m[1] : "";
}

// ── Write to Sheet ────────────────────────────────────────────────────────────
function writeToSheet(sheet, listings) {
  sheet.clearContents();

  const headers = ["Title", "Price", "Location", "URL", "Scraped At"];
  const rows    = listings.map(l => [
    l.title    || "N/A",
    l.price    || "N/A",
    l.location || "N/A",
    l.url      || "N/A",
    l.scraped,
  ]);

  const data = [headers, ...rows];
  sheet.getRange(1, 1, data.length, headers.length).setValues(data);

  // Style the header row
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange
    .setBackground("#1a3a5c")
    .setFontColor("#ffffff")
    .setFontWeight("bold")
    .setFontSize(11);

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);

  // Make URLs clickable
  const urlColumn = sheet.getRange(2, 4, rows.length, 1);
  urlColumn.setFontColor("#1155CC");

  Logger.log(`✅ Wrote ${rows.length} rows to sheet "${SHEET_NAME}"`);
}

// ── Sheet Helper ──────────────────────────────────────────────────────────────
function getOrCreateSheet(name) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    Logger.log(`Created new sheet: "${name}"`);
  }
  return sheet;
}

// ── Debug Helper (run this first to check the raw HTML) ──────────────────────
function debugFetch() {
  const html = fetchPage(SEARCH_URL);
  if (!html) {
    Logger.log("Fetch failed entirely.");
    return;
  }

  // Print first 3000 characters so you can inspect the HTML structure
  Logger.log("=== First 3000 chars of HTML ===");
  Logger.log(html.substring(0, 3000));

  // Count how many listing blocks were found
  const count1 = (html.match(/cl-static-search-result/g) || []).length;
  const count2 = (html.match(/result-row/g)              || []).length;
  Logger.log(`cl-static-search-result blocks found: ${count1}`);
  Logger.log(`result-row blocks found: ${count2}`);
}
