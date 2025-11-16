const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Main scraping endpoint for VAPI
app.post('/api/scrape', async (req, res) => {
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

    // Fetch and parse the webpage
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    
    // Remove script and style tags
    $('script, style, nav, footer, iframe').remove();
    
    // Extract relevant content
    const scrapedData = {
      title: $('title').text().trim(),
      headings: [],
      paragraphs: [],
      lists: [],
      contactInfo: extractContactInfo($),
      metadata: {
        description: $('meta[name="description"]').attr('content') || '',
        keywords: $('meta[name="keywords"]').attr('content') || ''
      }
    };

    // Extract headings (h1, h2, h3)
    $('h1, h2, h3').each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 0) {
        scrapedData.headings.push({
          level: el.name,
          text: text
        });
      }
    });

    // Extract paragraphs
    $('p').each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 20) {
        scrapedData.paragraphs.push(text);
      }
    });

    // Extract lists
    $('ul, ol').each((i, el) => {
      const items = [];
      $(el).find('li').each((j, li) => {
        const text = $(li).text().trim();
        if (text) items.push(text);
      });
      if (items.length > 0) {
        scrapedData.lists.push(items);
      }
    });

    // Create a focused summary based on the query
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
          relevantSections: relevantContent.details.slice(0, 10)
        })
      }]
    });

  } catch (error) {
    console.error('Scraping error:', error.message);
    
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
function extractContactInfo($) {
  const contactInfo = {
    emails: [],
    phones: [],
    socialMedia: []
  };

  const bodyText = $('body').text();
  
  // Email regex
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = bodyText.match(emailRegex);
  if (emails) {
    contactInfo.emails = [...new Set(emails)]
      .filter(email => !email.includes('.png') && !email.includes('.jpg'))
      .slice(0, 5);
  }

  // Phone regex (various formats)
  const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  const phones = bodyText.match(phoneRegex);
  if (phones) {
    contactInfo.phones = [...new Set(phones)]
      .filter(phone => phone.length >= 10)
      .slice(0, 5);
  }

  // Social media links
  $('a[href*="facebook.com"], a[href*="twitter.com"], a[href*="instagram.com"], a[href*="linkedin.com"]').each((i, el) => {
    const href = $(el).attr('href');
    if (href && contactInfo.socialMedia.length < 5) {
      contactInfo.socialMedia.push(href);
    }
  });

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
        score: matches
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

  // Sort by relevance score
  relevant.details.sort((a, b) => b.score - a.score);

  // Include contact info for relevant queries
  const contactKeywords = ['contact', 'email', 'phone', 'call', 'reach', 'address'];
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
  }

  // Create summary from top results
  const topResults = relevant.details.slice(0, 8);
  relevant.summary = topResults.map(item => item.text).join('\n\n');
  relevant.details = topResults.map(item => item.text);

  // Fallback if no relevant content found
  if (relevant.summary.length === 0) {
    relevant.summary = [
      data.title,
      data.metadata.description,
      ...data.headings.slice(0, 3).map(h => h.text),
      ...data.paragraphs.slice(0, 2)
    ].filter(Boolean).join('\n\n');
  }

  return relevant;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'VAPI Web Scraper'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'VAPI Web Scraper Tool',
    endpoints: {
      health: '/health',
      scrape: '/api/scrape (POST)'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 VAPI Web Scraper running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
});
