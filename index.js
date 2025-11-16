const express = require('express');
const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');
const axios = require('axios');
const pdf = require('pdf-parse');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Get Chromium executable path for Railway/Nix
function getChromiumPath() {
  // Railway with Nixpacks provides chromium at this path
  return process.env.PUPPETEER_EXECUTABLE_PATH || '/nix/store/*-chromium-*/bin/chromium';
}

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

    // Launch headless browser with Railway-optimized settings
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD ? '/usr/bin/chromium' : undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-dev-tools',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-images', // Speed optimization
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--single-process', // Important for Railway
        '--no-zygote' // Important for Railway
      ]
    });

    const page = await browser.newPage();
    
    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Block unnecessary resources for faster loading
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    // Navigate and wait for content to load
    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });

    // Wait for dynamic content
    await page.waitForTimeout(2000);

    // Extract all data
    const scrapedData = await page.evaluate(() => {
      const data = {
        title: document.title || '',
        headings: [],
        paragraphs: [],
        lists: [],
        links: [],
        images: [],
        metadata: {
          description: document.querySelector('meta[name="description"]')?.content || '',
          keywords: document.querySelector('meta[name="keywords"]')?.content || ''
        }
      };

      // Extract headings
      document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(el => {
        const text = el.innerText.trim();
        if (text && text.length > 0) {
          data.headings.push({
            level: el.tagName.toLowerCase(),
            text: text
          });
        }
      });

      // Extract paragraphs
      document.querySelectorAll('p, div, span, li, td, th').forEach(el => {
        const text = el.innerText?.trim();
        if (text && text.length > 20 && text.length < 1000) {
          data.paragraphs.push(text);
        }
      });

      // Extract lists
      document.querySelectorAll('ul, ol').forEach(el => {
        const items = [];
        el.querySelectorAll('li').forEach(li => {
          const text = li.innerText.trim();
          if (text) items.push(text);
        });
        if (items.length > 0) {
          data.lists.push(items);
        }
      });

      // Extract all links
      document.querySelectorAll('a[href]').forEach(el => {
        const href = el.href;
        const text = el.innerText.trim();
        if (href && text) {
          data.links.push({ href, text });
        }
      });

      // Extract all images with their URLs
      document.querySelectorAll('img').forEach(img => {
        const src = img.src;
        const alt = img.alt || '';
        if (src && !src.includes('data:image')) {
          data.images.push({ src, alt });
        }
      });

      return data;
    });

    // Extract contact information from visible text
    const bodyText = await page.evaluate(() => document.body.innerText);
    scrapedData.contactInfo = extractContactInfo(bodyText);

    // OCR on images if query relates to menus, prices, or visual content
    const visualKeywords = ['menu', 'price', 'pricing', 'cost', 'food', 'drink', 'special', 'beer', 'wine', 'coffee'];
    const needsOCR = visualKeywords.some(kw => query.toLowerCase().includes(kw));

    if (needsOCR && scrapedData.images.length > 0) {
      console.log('Running OCR on images...');
      scrapedData.imageText = await extractTextFromImages(scrapedData.images.slice(0, 3)); // Limit to 3 images
    }

    // Check for PDF links
    const pdfLinks = scrapedData.links.filter(link => 
      link.href.toLowerCase().endsWith('.pdf')
    );

    if (pdfLinks.length > 0 && needsOCR) {
      console.log('Found PDF links, extracting text...');
      scrapedData.pdfText = await extractTextFromPDFs(pdfLinks.slice(0, 2)); // Limit to 2 PDFs
    }

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
          relevantSections: relevantContent.details.slice(0, 15),
          imageText: scrapedData.imageText || [],
          pdfText: scrapedData.pdfText || []
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

// Extract text from images using OCR
async function extractTextFromImages(images) {
  const results = [];
  
  for (const img of images) {
    try {
      console.log(`Processing image: ${img.src}`);
      
      const { data: { text } } = await Tesseract.recognize(
        img.src,
        'eng',
        {
          logger: m => console.log(m)
        }
      );
      
      if (text && text.trim().length > 10) {
        results.push({
          source: img.src,
          alt: img.alt,
          extractedText: text.trim()
        });
      }
    } catch (err) {
      console.error(`Failed to OCR image ${img.src}:`, err.message);
    }
  }
  
  return results;
}

// Extract text from PDF files
async function extractTextFromPDFs(pdfLinks) {
  const results = [];
  
  for (const link of pdfLinks) {
    try {
      console.log(`Processing PDF: ${link.href}`);
      
      const response = await axios.get(link.href, {
        responseType: 'arraybuffer',
        timeout: 15000
      });
      
      const pdfData = await pdf(response.data);
      
      if (pdfData.text && pdfData.text.trim().length > 10) {
        results.push({
          source: link.href,
          title: link.text,
          extractedText: pdfData.text.trim()
        });
      }
    } catch (err) {
      console.error(`Failed to extract PDF ${link.href}:`, err.message);
    }
  }
  
  return results;
}

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
      .filter(email => !email.includes('.png') && !email.includes('.jpg'))
      .slice(0, 5);
  }

  // Phone regex (various formats)
  const phoneRegex = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  const phones = text.match(phoneRegex);
  if (phones) {
    contactInfo.phones = [...new Set(phones)]
      .filter(phone => phone.length >= 10)
      .slice(0, 5);
  }

  // Address regex (basic - looks for street patterns)
  const addressRegex = /\d{1,5}\s+[\w\s]{3,30}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)[.,]?\s*(?:Suite|Ste|Unit|#)?\s*[\w\d]*[,]?\s*[\w\s]+[,]\s*[A-Z]{2}\s*\d{5}/gi;
  const addresses = text.match(addressRegex);
  if (addresses) {
    contactInfo.addresses = [...new Set(addresses)].slice(0, 3);
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
    if (matches > 0) {
      relevant.details.push({
        type: 'heading',
        text: heading.text,
        score: matches * 3
      });
    }
  });

  // Score and collect relevant paragraphs
  data.paragraphs.forEach(para => {
    const paraLower = para.toLowerCase();
    const matches = keywords.filter(kw => paraLower.includes(kw)).length;
    if (matches > 0 && para.length < 500) {
      relevant.details.push({
        type: 'paragraph',
        text: para,
        score: matches
      });
    }
  });

  // Add OCR text if available
  if (data.imageText) {
    data.imageText.forEach(img => {
      const imgLower = img.extractedText.toLowerCase();
      const matches = keywords.filter(kw => imgLower.includes(kw)).length;
      if (matches > 0) {
        relevant.details.push({
          type: 'image_text',
          text: `[Menu Image] ${img.extractedText}`,
          score: matches * 2
        });
      }
    });
  }

  // Add PDF text if available
  if (data.pdfText) {
    data.pdfText.forEach(pdf => {
      const pdfLower = pdf.extractedText.toLowerCase();
      const matches = keywords.filter(kw => pdfLower.includes(kw)).length;
      if (matches > 0) {
        const excerpt = pdf.extractedText.substring(0, 800);
        relevant.details.push({
          type: 'pdf_text',
          text: `[From PDF: ${pdf.title}] ${excerpt}`,
          score: matches * 2
        });
      }
    });
  }

  // Sort by relevance score
  relevant.details.sort((a, b) => b.score - a.score);

  // Include contact info for relevant queries
  const contactKeywords = ['contact', 'email', 'phone', 'call', 'reach', 'address', 'location'];
  if (contactKeywords.some(kw => queryLower.includes(kw))) {
    if (data.contactInfo.emails.length > 0) {
      relevant.details.unshift({
        type: 'contact',
        text: `Email: ${data.contactInfo.emails.join(', ')}`,
        score: 999
      });
    }
    if (data.contactInfo.phones.length > 0) {
      relevant.details.unshift({
        type: 'contact',
        text: `Phone: ${data.contactInfo.phones.join(', ')}`,
        score: 999
      });
    }
    if (data.contactInfo.addresses.length > 0) {
      relevant.details.unshift({
        type: 'contact',
        text: `Address: ${data.contactInfo.addresses.join(', ')}`,
        score: 999
      });
    }
  }

  // Create summary from top results
  const topResults = relevant.details.slice(0, 12);
  relevant.summary = topResults.map(item => item.text).join('\n\n');
  relevant.details = topResults.map(item => item.text);

  // Fallback if no relevant content found
  if (relevant.summary.length === 0) {
    relevant.summary = [
      data.title,
      data.metadata.description,
      ...data.headings.slice(0, 5).map(h => h.text),
      ...data.paragraphs.slice(0, 3)
    ].filter(Boolean).join('\n\n');
  }

  return relevant;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'VAPI Enhanced Web Scraper',
    features: ['JavaScript rendering', 'OCR', 'PDF extraction']
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'VAPI Enhanced Web Scraper Tool',
    features: [
      'JavaScript-rendered content',
      'Image text extraction (OCR)',
      'PDF text extraction',
      'Contact information extraction'
    ],
    endpoints: {
      health: '/health',
      scrape: '/api/scrape (POST)'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 VAPI Enhanced Web Scraper running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`✨ Features: JS Rendering, OCR, PDF Extraction`);
});
