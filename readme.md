# Web Crawler & Scraper

An open-source web crawling and scraping engine built with **Node.js and TypeScript**.

The goal is to build a reusable tool that can:

-  Crawl websites and discover URLs
-  Extract structured data from web pages
-  Normalize and manage discovered URLs
-  Respect `robots.txt` and crawl responsibly
-  Handle concurrency, retries, and rate limiting
-  Use **Playwright** for JavaScript-rendered websites
-  Store and export scraped data

### Planned Architecture

```text
Website
   ↓
Crawler
   ↓
URL Queue
   ↓
Scraper
   ↓
Structured Data
   ↓
Storage / Export
```

The project focuses on learning and implementing the core concepts behind **web crawling, web scraping, and browser automation** while providing a practical open-source tool for developers.