/**
 * server/seo.mjs
 * Generates dynamic robots.txt and sitemap.xml grounded in real application data.
 */

import { products, categories } from './db/repository.mjs';
import config from './config.mjs';

function getBaseUrl(req) {
  if (config.appBaseUrl) return config.appBaseUrl.replace(/\/+$/, '');
  const host = req?.headers?.host || 'localhost:4000';
  const proto = req?.headers?.['x-forwarded-proto'] || (config.isProduction ? 'https' : 'http');
  return `${proto}://${host}`;
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

export function generateRobotsTxt(req) {
  const baseUrl = getBaseUrl(req);
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /admin',
    'Disallow: /admin.html',
    'Disallow: /orders',
    'Disallow: /orders.html',
    'Disallow: /invoice',
    'Disallow: /invoice.html',
    'Disallow: /reset-password',
    'Disallow: /reset-password.html',
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`,
    '',
  ].join('\n');
}

export async function generateSitemapXml(req) {
  const baseUrl = getBaseUrl(req);
  const now = new Date().toISOString().slice(0, 10);

  const allCategories = await categories.list();
  const activeProducts = [];
  let page = 1;
  let totalPages = 1;
  do {
    const result = await products.list({ limit: 200, page, includeInactive: false });
    activeProducts.push(...result.products);
    totalPages = result.totalPages;
    page++;
  } while (page <= totalPages);

  const urls = [
    { loc: `${baseUrl}/`, priority: '1.0', changefreq: 'daily' },
    { loc: `${baseUrl}/privacy`, priority: '0.3', changefreq: 'monthly' },
    { loc: `${baseUrl}/terms`, priority: '0.3', changefreq: 'monthly' },
    { loc: `${baseUrl}/delivery-policy`, priority: '0.4', changefreq: 'monthly' },
  ];

  for (const cat of allCategories) {
    urls.push({
      loc: `${baseUrl}/categories/${encodeURIComponent(cat.slug)}`,
      priority: '0.8',
      changefreq: 'daily',
    });
  }

  for (const p of activeProducts) {
    urls.push({
      loc: `${baseUrl}/products/${encodeURIComponent(p.slug || p.id)}`,
      priority: '0.9',
      changefreq: 'weekly',
      lastmod: p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 10) : now,
    });
  }

  const xmlEntries = urls.map(u => `  <url>
    <loc>${xmlEscape(u.loc)}</loc>
    ${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${xmlEntries}
</urlset>`;
}
