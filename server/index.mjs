import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, seed, slugify } from './db.mjs';
import { createPasswordHash, verifyPassword, issueToken, tokenHash, cleanText, validEmail } from './security.mjs';

seed();
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '127.0.0.1';
const publicDir = resolve(process.cwd(), 'web');
const extraOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webp':'image/webp','.json':'application/json'};
const json = (res, status, body) => {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(body));
};
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const ensure = (condition, code, message) => { if (!condition) fail(code,message); };

async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) fail(413,'Request body too large');
  }
  try { return JSON.parse(raw || '{}'); } catch { fail(400,'Invalid JSON body'); }
}
function getUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (!/^[a-zA-Z0-9_-]{30,150}$/.test(token)) return null;
  const record = db.prepare(`SELECT u.id,u.name,u.email,u.role FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`)
    .get(tokenHash(token),Math.floor(Date.now()/1000));
  return record || null;
}
function authUser(req, admin=false) {
  const user = getUser(req);
  ensure(user,401,'Please sign in to continue');
  if (admin) ensure(user.role === 'ADMIN',403,'Administrator access required');
  return user;
}
function session(user) {
  const token = issueToken();
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)')
    .run(tokenHash(token),user.id,Math.floor(Date.now()/1000)+60*60*24*7);
  return {token,user:{id:user.id,name:user.name,email:user.email,role:user.role}};
}
function productQuery(limit=80, filter='') {
  return `SELECT p.id,p.name,p.slug,p.description,p.price,p.stock,p.image_url AS imageUrl,
    p.featured,p.active,c.name AS category,c.slug AS categorySlug,p.created_at AS createdAt
    FROM products p LEFT JOIN categories c ON c.id=p.category_id ${filter} LIMIT ${limit}`;
}
function sanitizeProduct(input, partial=false) {
  const fields = {};
  for (const k of ['name','description','imageUrl','categorySlug']) if (input[k] !== undefined) fields[k] = cleanText(input[k], k==='description'?1200:200);
  for (const k of ['price','stock']) if (input[k] !== undefined) {
    const value = Number(input[k]);
    ensure(Number.isSafeInteger(value) && value>=0 && value <= (k==='price'?100000000:1000000),400,`Invalid ${k}`);
    fields[k]=value;
  }
  for (const k of ['featured','active']) if (input[k] !== undefined) fields[k]=input[k] ? 1 : 0;
  if (fields.imageUrl !== undefined) {
    ensure(!fields.imageUrl || fields.imageUrl.startsWith('/assets/products/') || /^https:\/\//.test(fields.imageUrl),400,'Image must be HTTPS or a local product asset');
  }
  if (!partial) {
    ensure(fields.name && fields.price!==undefined && fields.stock!==undefined,400,'Name, price and stock are required');
  }
  if (fields.categorySlug !== undefined) {
    const category=db.prepare('SELECT id FROM categories WHERE slug=?').get(slugify(fields.categorySlug));
    ensure(category,400,'Unknown category');
    fields.categoryId=category.id;
    delete fields.categorySlug;
  }
  return fields;
}
const attempts = new Map();
function rateLimit(req, endpoint) {
  const key = `${req.socket.remoteAddress}:${endpoint}`;
  const now=Date.now();
  const entry=attempts.get(key) || {count:0, until:now+15*60*1000};
  if (now>entry.until) {entry.count=0;entry.until=now+15*60*1000;}
  entry.count+=1;attempts.set(key,entry);
  ensure(entry.count<=15,429,'Too many attempts. Try again later');
  if(attempts.size>2000) for (const [k,v] of attempts) if(v.until<now) attempts.delete(k);
}

async function api(req,res,url) {
  const path=url.pathname, method=req.method;
  if (path==='/api/health' && method==='GET') return json(res,200,{ok:true,service:'iwacumall-api',database:'connected'});
  if (path==='/api/config' && method==='GET') return json(res,200,{storeName:process.env.STORE_NAME||'IwacuMall',storeAddress:process.env.STORE_ADDRESS||'Downtown Kigali',storePhone:process.env.STORE_PHONE||'0788651421',currency:'RWF',paymentMethods:['CASH_ON_DELIVERY'],deliveryPolicy:'Delivery charges, if any, are confirmed by the store separately.'});
  if (path==='/api/categories' && method==='GET') return json(res,200,{categories:db.prepare('SELECT id,name,slug FROM categories ORDER BY name').all()});
  if (path==='/api/products' && method==='GET') {
    const category=cleanText(url.searchParams.get('category')||'',60);
    const search=cleanText(url.searchParams.get('search')||'',100);
    const featured=url.searchParams.get('featured')==='1';
    const limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||80));
    const parts=['p.active=1']; const args=[];
    if(category) {parts.push('c.slug=?');args.push(category);}
    if(search) {parts.push('(p.name LIKE ? OR p.description LIKE ?)');args.push(`%${search}%`,`%${search}%`);}
    if(featured) parts.push('p.featured=1');
    const rows=db.prepare(productQuery(limit,`WHERE ${parts.join(' AND ')} ORDER BY p.featured DESC,p.created_at DESC`)).all(...args);
    return json(res,200,{products:rows});
  }
  if (/^\/api\/products\/[a-zA-Z0-9-]+$/.test(path) && method==='GET') {
    const id=path.split('/').pop();
    const row=db.prepare(productQuery(1,'WHERE p.id=? AND p.active=1')).get(id);
    ensure(row,404,'Product not found');return json(res,200,{product:row});
  }
  if(path==='/api/auth/register'&&method==='POST') {
    rateLimit(req,'register');const b=await bodyJson(req);
    const name=cleanText(b.name,100),email=cleanText(b.email,254).toLowerCase(), password=b.password;
    ensure(name.length>=2 && validEmail(email) && typeof password==='string' && password.length>=10 && password.length<=128,400,'Provide name, valid email, and password of 10–128 characters');
    ensure(!db.prepare('SELECT id FROM users WHERE email=?').get(email),409,'Email already registered');
    const id=randomUUID();
    db.prepare('INSERT INTO users(id,name,email,password_hash,role) VALUES(?,?,?,?,?)').run(id,name,email,createPasswordHash(password),'CUSTOMER');
    return json(res,201,session({id,name,email,role:'CUSTOMER'}));
  }
  if(path==='/api/auth/login'&&method==='POST') {
    rateLimit(req,'login');const b=await bodyJson(req);
    const email=cleanText(b.email,254).toLowerCase(),password=b.password;
    ensure(validEmail(email) && typeof password==='string' && password.length<=128,400,'Invalid credentials');
    const user=db.prepare('SELECT id,name,email,password_hash,role FROM users WHERE email=?').get(email);
    ensure(user && verifyPassword(password,user.password_hash),401,'Invalid email or password');
    return json(res,200,session(user));
  }
  if(path==='/api/auth/logout'&&method==='POST') {
    authUser(req);const token=req.headers.authorization.slice(7);
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
    return json(res,200,{ok:true});
  }
  if(path==='/api/me'&&method==='GET') return json(res,200,{user:authUser(req)});
  if(path==='/api/me/orders'&&method==='GET') {
    const user=authUser(req);
    const orders=db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').all(user.id);
    for(const order of orders) order.items=db.prepare('SELECT product_id,product_name,unit_price,quantity FROM order_items WHERE order_id=?').all(order.id);
    return json(res,200,{orders});
  }
  if(path==='/api/orders'&&method==='POST') {
    const user=authUser(req),b=await bodyJson(req);
    const customerName=cleanText(b.customerName||user.name,100),phone=cleanText(b.phone,30),address=cleanText(b.address,180),city=cleanText(b.city,90),note=cleanText(b.note||'',500);
    ensure(customerName.length>=2 && phone.length>=8 && phone.length<=20 && address.length>=5 && city.length>=2,400,'Complete your name, phone number, city and delivery address');
    ensure(Array.isArray(b.items) && b.items.length>=1 && b.items.length<=50,400,'Your cart is empty or too large');
    const merged=new Map();
    for(const item of b.items) {
      const id=cleanText(item.productId,60),quantity=Number(item.quantity);
      ensure(id && Number.isSafeInteger(quantity) && quantity>=1 && quantity<=100,400,'Invalid cart item');
      merged.set(id,(merged.get(id)||0)+quantity);
      ensure(merged.get(id)<=100,400,'Maximum quantity is 100 per item');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const items=[];
      for(const [id,quantity] of merged) {
        const p=db.prepare('SELECT id,name,price,stock FROM products WHERE id=? AND active=1').get(id);
        ensure(p,400,'A product in your cart is unavailable');
        ensure(p.stock>=quantity,409,`Not enough stock for ${p.name}`);
        items.push({p,quantity});
      }
      const subtotal=items.reduce((total,{p,quantity})=>total+p.price*quantity,0);
      ensure(Number.isSafeInteger(subtotal) && subtotal<=1000000000,400,'Order value is too large');
      const id=randomUUID();
      db.prepare(`INSERT INTO orders(id,user_id,customer_name,phone,address,city,note,subtotal,delivery_fee,total)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,user.id,customerName,phone,address,city,note,subtotal,0,subtotal);
      for(const {p,quantity} of items) {
        const updated=db.prepare('UPDATE products SET stock=stock-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND stock>=?').run(quantity,p.id,quantity);
        ensure(updated.changes===1,409,'Stock changed. Please retry');
        db.prepare('INSERT INTO order_items(id,order_id,product_id,product_name,unit_price,quantity) VALUES(?,?,?,?,?,?)')
          .run(randomUUID(),id,p.id,p.name,p.price,quantity);
      }
      db.exec('COMMIT');return json(res,201,{order:{id,total:subtotal,status:'PLACED',items:items.length}});
    } catch(e) {db.exec('ROLLBACK');throw e;}
  }
  if(/^\/api\/orders\/[a-zA-Z0-9-]+$/.test(path) && method==='GET') {
    const user=authUser(req),id=path.split('/').pop();
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    ensure(order && (order.user_id===user.id || user.role==='ADMIN'),404,'Order not found');
    order.items=db.prepare('SELECT product_id,product_name,unit_price,quantity FROM order_items WHERE order_id=?').all(id);
    return json(res,200,{order});
  }
  if(path==='/api/admin/stats' && method==='GET') {
    authUser(req,true);
    return json(res,200,{stats:{products:db.prepare('SELECT COUNT(*) n FROM products WHERE active=1').get().n,
      customers:db.prepare("SELECT COUNT(*) n FROM users WHERE role='CUSTOMER'").get().n,
      orders:db.prepare('SELECT COUNT(*) n FROM orders').get().n,
      revenue:db.prepare("SELECT COALESCE(SUM(total),0) n FROM orders WHERE status='DELIVERED'").get().n,
      openOrders:db.prepare("SELECT COUNT(*) n FROM orders WHERE status NOT IN ('DELIVERED','CANCELLED')").get().n}});
  }
  if(path==='/api/admin/orders' && method==='GET') {
    authUser(req,true);
    const orders=db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all();
    for(const order of orders) order.items=db.prepare('SELECT product_name,quantity,unit_price FROM order_items WHERE order_id=?').all(order.id);
    return json(res,200,{orders});
  }
  if(/^\/api\/admin\/orders\/[a-zA-Z0-9-]+\/status$/.test(path) && method==='PATCH') {
    authUser(req,true); const id=path.split('/')[4],b=await bodyJson(req);
    const transitions={PLACED:['CONFIRMED','CANCELLED'],CONFIRMED:['PACKING','CANCELLED'],PACKING:['OUT_FOR_DELIVERY','CANCELLED'],OUT_FOR_DELIVERY:['DELIVERED','CANCELLED'],DELIVERED:[],CANCELLED:[]};
    const old=db.prepare('SELECT status FROM orders WHERE id=?').get(id);
    ensure(old,404,'Order not found');ensure(transitions[old.status]?.includes(b.status),400,'Invalid order status transition');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE orders SET status=? WHERE id=?').run(b.status,id);
      if(b.status==='CANCELLED') {
        const lines=db.prepare('SELECT product_id,quantity FROM order_items WHERE order_id=?').all(id);
        for(const line of lines) db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(line.quantity,line.product_id);
      }
      db.exec('COMMIT');return json(res,200,{ok:true,status:b.status});
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  if(path==='/api/admin/products' && method==='GET') {
    authUser(req,true);return json(res,200,{products:db.prepare(productQuery(200,'ORDER BY p.created_at DESC')).all()});
  }
  if(path==='/api/admin/products' && method==='POST') {
    authUser(req,true);const b=sanitizeProduct(await bodyJson(req));
    const id=randomUUID(), slug=`${slugify(b.name)}-${id.slice(0,6)}`;
    db.prepare(`INSERT INTO products(id,name,slug,description,price,stock,category_id,image_url,featured,active)
      VALUES(?,?,?,?,?,?,?,?,?,1)`).run(id,b.name,slug,b.description||'',b.price,b.stock,b.categoryId||null,b.imageUrl||'',b.featured||0);
    return json(res,201,{id,slug});
  }
  if(/^\/api\/admin\/products\/[a-zA-Z0-9-]+$/.test(path)) {
    authUser(req,true);const id=path.split('/').pop();
    ensure(db.prepare('SELECT id FROM products WHERE id=?').get(id),404,'Product not found');
    if(method==='DELETE') {db.prepare('UPDATE products SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id);return json(res,200,{ok:true});}
    if(method==='PATCH') {
      const b=sanitizeProduct(await bodyJson(req),true);
      const map={name:'name',description:'description',imageUrl:'image_url',categoryId:'category_id',price:'price',stock:'stock',featured:'featured',active:'active'};
      const entries=Object.entries(b).filter(([k])=>map[k]);ensure(entries.length>0,400,'No valid changes');
      const assigns=entries.map(([k])=>`${map[k]}=?`).join(',');
      db.prepare(`UPDATE products SET ${assigns},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...entries.map(([,v])=>v),id);
      return json(res,200,{ok:true});
    }
  }
  if(path==='/api/admin/categories' && method==='POST') {
    authUser(req,true);const b=await bodyJson(req);const name=cleanText(b.name,80),slug=slugify(name);
    ensure(name.length>=2 && slug,400,'Enter a valid category name');
    ensure(!db.prepare('SELECT id FROM categories WHERE slug=?').get(slug),409,'Category already exists');
    const id=randomUUID();db.prepare('INSERT INTO categories(id,name,slug) VALUES(?,?,?)').run(id,name,slug);
    return json(res,201,{id,name,slug});
  }
  fail(404,'API endpoint not found');
}
async function serveStatic(req,res,url) {
  if(req.method !== 'GET' && req.method !== 'HEAD') return json(res,405,{error:'Method not allowed'});
  let path;
  try {path=decodeURIComponent(url.pathname);} catch {return json(res,400,{error:'Invalid path'});}
  if(path==='/' || path==='/shop') path='/index.html';
  if(path==='/admin') path='/admin.html';
  if(path==='/orders') path='/orders.html';
  const target=resolve(publicDir,`.${path}`);
  if(target!==publicDir && !target.startsWith(publicDir+sep)) return json(res,403,{error:'Forbidden'});
  try {
    const info=await stat(target); if(!info.isFile()) return json(res,404,{error:'Not found'});
    const contents=await readFile(target);
    res.writeHead(200,{'Content-Type':mime[extname(target)]||'application/octet-stream',
      'Cache-Control':target.endsWith('.html')?'no-cache':'public, max-age=3600',
      'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin-when-cross-origin',
      'Content-Security-Policy':"default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"});
    if(req.method==='HEAD')return res.end();res.end(contents);
  } catch {json(res,404,{error:'Not found'});}
}
const server=http.createServer(async (req,res)=>{
  try {
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    const origin=req.headers.origin;
    const trustedOrigin=!origin || extraOrigins.includes(origin) || new URL(origin).host===req.headers.host;
    if(origin && !trustedOrigin && url.pathname.startsWith('/api')) return json(res,403,{error:'Origin not allowed'});
    if(origin && trustedOrigin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','GET, POST, PATCH, DELETE, OPTIONS');}
    if(req.method==='OPTIONS') {res.writeHead(204);return res.end();}
    if(url.pathname.startsWith('/api/')) return await api(req,res,url);
    return await serveStatic(req,res,url);
  }catch(e) {
    const status=Number(e?.status)||500;
    if(status===500)console.error('[server]',e);
    if(!res.headersSent)json(res,status,{error:status===500?'Unexpected server error':e.message});
  }
});
if(process.env.NODE_ENV!=='test')server.listen(PORT,HOST,()=>console.log(`IwacuMall running on http://${HOST}:${PORT}`));
export {server};
