import time
import logging
from dataclasses import dataclass
from datetime import datetime

import requests
from bs4 import BeautifulSoup
import gspread
from google.oauth2.service_account import Credentials


# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


# ── Config ────────────────────────────────────────────────────────────────────
BASE_URL    = "https://manila.craigslist.org"
SEARCH_URL  = "https://manila.craigslist.org/search/rea"
MAX_PAGES   = 3          # each page = 120 listings
DELAY_SEC   = 2.0        # seconds between requests — be polite

# Google Sheets config
CREDENTIALS_FILE = "credentials.json"   # your service account key
SPREADSHEET_URL  = "https://docs.google.com/spreadsheets/d/1Q7xejQhpDY7-chy05S3Ux53R9ofvNDixextEsG_-3Bg/edit?gid=0#gid=0"   # ← paste your sheet URL
WORKSHEET_NAME   = "Craigslist Listings"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


# ── Data Model ────────────────────────────────────────────────────────────────
@dataclass
class Listing:
    title:      str
    price:      str
    location:   str
    url:        str
    scraped_at: str


# ── Scraper ───────────────────────────────────────────────────────────────────
class CraigslistScraper:

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update(HEADERS)

    def fetch(self, url: str) -> BeautifulSoup | None:
        """Fetch a URL and return a BeautifulSoup object."""
        try:
            log.info(f"Fetching: {url}")
            res = self.session.get(url, timeout=15)
            res.raise_for_status()
            return BeautifulSoup(res.text, "html.parser")
        except requests.RequestException as e:
            log.error(f"Fetch failed: {e}")
            return None

    def parse_page(self, soup: BeautifulSoup) -> list[Listing]:
        """
        Parse one page of search results.

        Craigslist HTML structure (new design):
        <li class="cl-static-search-result">
          <a href="/reb/d/listing-title/1234567890.html">
            <div class="title">Listing Title</div>
            <div class="price">₱1,500,000</div>
            <div class="location">Quezon City</div>
          </a>
        </li>
        """
        listings = []
        now      = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # ── Strategy 1: New Craigslist design ────────────────────────────────
        cards = soup.select("li.cl-static-search-result")

        # ── Strategy 2: Fallback — older design ──────────────────────────────
        if not cards:
            log.warning("New design selectors found nothing — trying legacy selectors.")
            cards = soup.select("li.result-row")

        if not cards:
            log.warning("No listing cards found on this page.")
            return listings

        for card in cards:
            # New design fields
            title_el    = card.select_one("div.title") or card.select_one(".titlestring")
            price_el    = card.select_one("div.price") or card.select_one(".result-price")
            location_el = card.select_one("div.location") or card.select_one(".result-hood")
            link_el     = card.select_one("a[href]")

            title    = title_el.get_text(strip=True)    if title_el    else "N/A"
            price    = price_el.get_text(strip=True)    if price_el    else "N/A"
            location = location_el.get_text(strip=True) if location_el else "N/A"
            href     = link_el["href"]                  if link_el     else ""

            # Make sure URL is absolute
            url = href if href.startswith("http") else BASE_URL + href

            if title and title != "N/A":
                listings.append(Listing(
                    title      = title,
                    price      = price,
                    location   = location,
                    url        = url,
                    scraped_at = now,
                ))

        log.info(f"  → Parsed {len(listings)} listings from this page")
        return listings

    def scrape_all(self) -> list[Listing]:
        """Scrape all pages up to MAX_PAGES."""
        all_listings = []

        for page in range(MAX_PAGES):
            # Craigslist paginates with ?s=0, ?s=120, ?s=240 ...
            offset = page * 120
            url    = SEARCH_URL + (f"?s={offset}" if page > 0 else "")

            soup = self.fetch(url)
            if not soup:
                break

            page_listings = self.parse_page(soup)
            if not page_listings:
                log.info("No more listings — stopping pagination.")
                break

            all_listings.extend(page_listings)
            log.info(f"Page {page + 1} done. Running total: {len(all_listings)}")

            if page < MAX_PAGES - 1:
                time.sleep(DELAY_SEC)

        return all_listings


# ── Google Sheets Exporter ────────────────────────────────────────────────────
class SheetsExporter:

    def __init__(self):
        creds        = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
        client       = gspread.authorize(creds)
        spreadsheet  = client.open_by_url(SPREADSHEET_URL)

        # Get or create the worksheet tab
        try:
            self.sheet = spreadsheet.worksheet(WORKSHEET_NAME)
        except gspread.WorksheetNotFound:
            self.sheet = spreadsheet.add_worksheet(WORKSHEET_NAME, rows=1000, cols=10)

        log.info(f"Connected to Google Sheets → tab: '{WORKSHEET_NAME}'")

    def export(self, listings: list[Listing]):
        """Write all listings to the sheet in one batch call."""
        if not listings:
            log.warning("Nothing to export.")
            return

        header = ["Title", "Price", "Location", "URL", "Scraped At"]
        rows   = [
            [l.title, l.price, l.location, l.url, l.scraped_at]
            for l in listings
        ]

        # Clear old data and write everything at once (one API call = no rate limits)
        self.sheet.clear()
        self.sheet.update("A1", [header] + rows)

        # Format the header row
        self.sheet.format("A1:E1", {
            "textFormat":          {"bold": True, "fontSize": 11},
            "backgroundColor":     {"red": 0.1, "green": 0.23, "blue": 0.36},
            "horizontalAlignment": "CENTER",
        })
        self.sheet.freeze(rows=1)

        log.info(f"✅ Exported {len(listings)} listings to Google Sheets.")


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    # 1. Scrape
    scraper  = CraigslistScraper()
    listings = scraper.scrape_all()

    if not listings:
        log.error("No listings scraped. Check your internet connection or inspect the HTML.")
        return

    log.info(f"Total listings scraped: {len(listings)}")

    # 2. Preview first 3 in terminal
    print("\n── Preview (first 3 listings) ──────────────────")
    for l in listings[:3]:
        print(f"  {l.title}")
        print(f"  {l.price}  |  {l.location}")
        print(f"  {l.url}")
        print()

    # 3. Export to Google Sheets
    exporter = SheetsExporter()
    exporter.export(listings)


if __name__ == "__main__":
    main()
