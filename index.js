const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Main scraping endpoint for VAPI
app.post('/api/scrape', async (req, res) => {
  let browser;
  
  try {
    console.log('Received scrape request:', JSON.stringify(req.body, null, 2));
    
    const { url, query } = req.body.message.toolCalls[0].function.arguments;
    
    // Validate URL
    if (!url || !isValidUrl(url)) {
      return res.json({
        results: [{
          toolCallId: req.body.message.toolCalls[0].id,
          result: JSON.stringify({
            success: false,
            error: "Invalid URL provided"
          })
        }]
      });
    }

    console.log(`Scraping URL: ${url} for query: ${query}`);

    // Launch browser with minimal flags for Railway
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Navigate with timeout
    await page.goto(url, { 
      waitUntil: 'networkidle0',
      timeout: 25000 
    });

    // Small wait for dynamic content
    await page.waitForTimeout(1500);

    // Extract all data
    const scrapedData = await page.evaluate(() => {
      const data = {
        title: document.title || '',
        headings: [],
        paragraphs: [],
        lists: [],
        links: [],
        images: [],
        tables: [],
        metadata: {
          description: document.querySelector('meta[name="description"]')?.content || '',
          keywords: document.querySelector('meta[name="keywords"]')?.content || '',
          ogTitle: document.querySelector('meta[property="og:title"]')?.content || '',
          ogDescription: document.querySelector('meta[property="og:description"]')?.content || ''
        }
      };

      // Extract headings
      document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(el => {
        const text = el.innerText?.trim();
        if (text && text.length > 0) {
          data.headings.push({
            level: el.tagName.toLowerCase(),
            text: text
          });
        }
      });

      // Extract all visible text elements
      document.querySelectorAll('p, div, span, li, td, th, a, button, label').forEach(el => {
        const text = el.innerText?.trim();
        // Only get direct text, avoid duplicates from nested elements
        if (text && text.length > 15 && text.length < 1000) {
          const hasChildWithSameText = Array.from(el.children).some(child => 
            child.innerText?.trim() === text
          );
          if (!hasChildWithSameText) {
            data.paragraphs.push(text);
          }
        }
      });

      // Extract lists
      document.querySelectorAll('ul, ol').forEach(el => {
        const items = [];
        el.querySelectorAll('li').forEach(li => {
          const text = li.innerText?.trim();
          if (text) items.push(text);
        });
        if (items.length > 0) {
          data.lists.push(items);
        }
      });

      // Extract tables
      document.querySelectorAll('table').forEach(table => {
        const rows = [];
        table.querySelectorAll('tr').forEach(tr => {
          const cells = [];
          tr.querySelectorAll('td, th').forEach(cell => {
            cells.push(cell.innerText?.trim() || '');
          });
          if (cells.length > 0) rows.push(cells);
        });
        if (rows.length > 0) {
          data.tables.push(rows);
        }
      });

      // Extract all links
      document.querySelectorAll('a[href]').forEach(el => {
        const href = el.href;
        const text = el.innerText?.trim();
        if (href && text && text.length > 0) {
          data.links.push({ href, text });
        }
      });

      // Extract images with alt text
      document.querySelectorAll('img').forEach(img => {
        const src = img.src;
        const alt = img.alt?.trim() || '';
        if (src && !src.includes('data:image')) {
          data.images.push({ src, alt });
        }
      });

      return data;
    });

    // Get all body text for contact extraction
    const bodyText = await page.evaluate(() => document.body.innerText);
    scrapedData.contactInfo = extractContactInfo(bodyText);

    await browser.close();

    // Filter content based on query
    const relevantContent = filterRelevantContent(scrapedData, query);

    console.log('Scraping successful');

    return res.json({
      results: [{
        toolCallId: req.body.message.toolCalls[0].id,
        result: JSON.stringify({
          success: true,
          url: url,
          query: query,
          title: scrapedData.title,
          summary: relevantContent.summary,
          contactInfo: scrapedData.contactInfo,
          relevantSections: relevantContent.details.slice(0, 20),
          metadata: scrapedData.metadata
        })
      }]
    });

  } catch (error) {
    console.error('Scraping error:', error.message);
    
    if (browser) {
      await browser.close();
    }
    
    return res.json({
      results: [{
        toolCallId: req.body.message.toolCalls[0].id,
        result: JSON.stringify({
          success: false,
          error: `Failed to scrape website: ${error.message}`
        })
      }]
    });
  }
});

// Helper function to validate URLs
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Helper function to extract contact information
function extractContactInfo(text) {
  const contactInfo = {
    emails: [],
    phones: [],
    addresses: []
  };

  // Email regex
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = text.match(emailRegex);
  if (emails) {
    contactInfo.emails = [...new Set(emails)]
      .filter(email => 
        !email.includes('.png') && 
        !email.includes('.jpg') &&
        !email.includes('.gif') &&
        !email.toLowerCase().includes('example')
      )
      .slice(0, 5);
  }

  // Phone regex - multiple formats
  const phoneRegex = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  const phones = text.match(phoneRegex);
  if (phones) {
    contactInfo.phones = [...new Set(phones)]
      .filter(phone => phone.replace(/\D/g, '').length >= 10)
      .slice(0, 5);
  }

  // Address regex - looks for street patterns
  const addressRegex = /\d{1,6}\s+[\w\s]{3,50}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Circle|Cir|Way|Parkway|Pkwy)[.,]?\s*(?:Suite|Ste|Unit|Apt|#)?\s*[\w\d]*[,]?\s*[\w\s]+[,]\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?/gi;
  const addresses = text.match(addressRegex);
  if (addresses) {
    contactInfo.addresses = [...new Set(addresses)].slice(0, 3);
  }

  // Hours regex - common patterns
  const hoursRegex = /(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)[\s:-]+\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)?[\s-]+\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)?/gi;
  const hours = text.match(hoursRegex);
  if (hours) {
    contactInfo.hours = [...new Set(hours)].slice(0, 7);
  }

  return contactInfo;
}

// Helper function to filter content based on query
function filterRelevantContent(data, query) {
  const queryLower = query.toLowerCase();
  const keywords = queryLower.split(' ').filter(w => w.length > 2);
  
  const relevant = {
    summary: '',
    details: []
  };

  // Score and collect relevant headings
  data.headings.forEach(heading => {
    const headingLower = heading.text.toLowerCase();
    const matches = keywords.filter(kw => headingLower.includes(kw)).length;
    if (matches > 0 || keywords.length === 0) {
      relevant.details.push({
        type: 'heading',
        text: heading.text,
        score: matches * 3
      });
    }
  });

  // Score and collect relevant paragraphs
  const uniqueParagraphs = [...new Set(data.paragraphs)];
  uniqueParagraphs.forEach(para => {
    const paraLower = para.toLowerCase();
    const matches = keywords.filter(kw => paraLower.includes(kw)).length;
    if ((matches > 0 || keywords.length === 0) && para.length < 800) {
      relevant.details.push({
        type: 'text',
        text: para,
        score: matches
      });
    }
  });

  // Add table data for relevant queries
  if (data.tables.length > 0) {
    const tableKeywords = ['price', 'pricing', 'menu', 'cost', 'schedule', 'hours'];
    if (tableKeywords.some(kw => queryLower.includes(kw))) {
      data.tables.forEach(table => {
        const tableText = table.map(row => row.join(' | ')).join('\n');
        relevant.details.push({
          type: 'table',
          text: `Table:\n${tableText}`,
          score: 5
        });
      });
    }
  }

  // Sort by relevance score
  relevant.details.sort((a, b) => b.score - a.score);

  // Include contact info for relevant queries
  const contactKeywords = ['contact', 'email', 'phone', 'call', 'reach', 'address', 'location', 'hours', 'open'];
  if (contactKeywords.some(kw => queryLower.includes(kw))) {
    if (data.contactInfo.emails.length > 0) {
      relevant.details.unshift({
        type: 'contact',
        text: `📧 Email: ${data.contactInfo.emails.join(', ')}`,
        score: 999
      });
    }
    if (data.contactInfo.phones.length > 0) {
      relevant.details.unshift({
        type: 'contact',
        text: `📞 Phone: ${data.contactInfo.phones.join(', ')}`,
        score: 999
      });
    }
    if (data.contactInfo.addresses.length > 0) {
      relevant.details.unshift({
        type: 'contact',
        text: `📍 Address: ${data.contactInfo.addresses.join(', ')}`,
        score: 999
      });
    }
    if (data.contactInfo.hours && data.contactInfo.hours.length > 0) {
      relevant.details.unshift({
        type: 'contact',
        text: `🕐 Hours: ${data.contactInfo.hours.join(', ')}`,
        score: 999
      });
    }
  }

  // Create summary from top results
  const topResults = relevant.details.slice(0, 15);
  relevant.summary = topResults.map(item => item.text).join('\n\n');
  relevant.details = topResults.map(item => item.text);

  // Fallback if no relevant content found
  if (relevant.summary.length === 0) {
    relevant.summary = [
      data.title,
      data.metadata.description || data.metadata.ogDescription,
      ...data.headings.slice(0, 5).map(h => h.text),
      ...uniqueParagraphs.slice(0, 5)
    ].filter(Boolean).join('\n\n');
  }

  return relevant;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'VAPI Lightweight Web Scraper',
    features: ['JavaScript rendering', 'Contact extraction', 'Fast deployment']
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'VAPI Lightweight Web Scraper Tool',
    features: [
      'JavaScript-rendered content (React, Vue, Angular)',
      'Smart contact information extraction',
      'Table data extraction',
      'Fast and reliable'
    ],
    endpoints: {
      health: '/health',
      scrape: '/api/scrape (POST)'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 VAPI Lightweight Scraper running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`⚡ Optimized for speed and reliability`);
});
