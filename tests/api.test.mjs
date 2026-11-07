import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir=mkdtempSync(join(tmpdir(),'iwacumall-test-'));
process.env.NODE_ENV='test';
process.env.DATABASE_PATH=join(tempDir,'test.sqlite');
process.env.ADMIN_EMAIL='admin@test.example';
process.env.ADMIN_PASSWORD='VeryStrongTest12345!';
const { server }=await import('../server/index.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

async function api(path, method='GET', data,token) {
  const res=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(data?{body:JSON.stringify(data)}:{})});
  return {status:res.status,data:await res.json()};
}

test('end-to-end customer, inventory and administrator order workflows',async(t)=>{
  const health=await api('/health');
  assert.equal(health.status,200);
  const products=await api('/products');
  assert.equal(products.status,200);
  assert.ok(products.data.products.length>=10);
  const starting=products.data.products.find(p=>p.name==='Wireless Headphones');
  assert.ok(starting);

  const denied=await api('/admin/orders');
  assert.equal(denied.status,401);
  const invalid=await api('/auth/register','POST',{name:'X',email:'bad',password:'123'});
  assert.equal(invalid.status,400);

  const registered=await api('/auth/register','POST',{name:'Test Customer',email:'buyer@test.example',password:'customerTest123456'});
  assert.equal(registered.status,201);
  assert.equal(registered.data.user.role,'CUSTOMER');
  const customerToken=registered.data.token;
  const duplicate=await api('/auth/register','POST',{name:'Test Customer',email:'buyer@test.example',password:'customerTest123456'});
  assert.equal(duplicate.status,409);

  const order=await api('/orders','POST',{customerName:'Test Customer',phone:'0788000000',city:'Kigali',address:'Kicukiro, main road',items:[{productId:starting.id,quantity:2}]},customerToken);
  assert.equal(order.status,201);
  assert.equal(order.data.order.total,starting.price*2);
  const id=order.data.order.id;
  const updated=await api(`/products/${starting.id}`);
  assert.equal(updated.data.product.stock,starting.stock-2);

  const invalidStock=await api('/orders','POST',{customerName:'Test Customer',phone:'0788000000',city:'Kigali',address:'Kicukiro, main road',items:[{productId:starting.id,quantity:100}]},customerToken);
  assert.equal(invalidStock.status,409);
  const check=await api('/me/orders','GET',null,customerToken);
  assert.equal(check.data.orders.length,1);
  assert.equal(check.data.orders[0].items[0].quantity,2);

  const adminLogin=await api('/auth/login','POST',{email:'admin@test.example',password:'VeryStrongTest12345!'});
  assert.equal(adminLogin.status,200);
  const adminToken=adminLogin.data.token;
  const adminOrders=await api('/admin/orders','GET',null,adminToken);
  assert.equal(adminOrders.data.orders.length,1);
  const forbidden=await api('/admin/stats','GET',null,customerToken);
  assert.equal(forbidden.status,403);
  const confirmed=await api(`/admin/orders/${id}/status`,'PATCH',{status:'CONFIRMED'},adminToken);
  assert.equal(confirmed.status,200);
  const rejected=await api(`/admin/orders/${id}/status`,'PATCH',{status:'DELIVERED'},adminToken);
  assert.equal(rejected.status,400);
  const cancelled=await api(`/admin/orders/${id}/status`,'PATCH',{status:'CANCELLED'},adminToken);
  assert.equal(cancelled.status,200);
  const restored=await api(`/products/${starting.id}`);
  assert.equal(restored.data.product.stock,starting.stock);

  const categories=await api('/categories');
  assert.ok(categories.data.categories.length>=6);
  const newProduct=await api('/admin/products','POST',{name:'Demo Test Product',description:'New product',price:5000,stock:4,categorySlug:'groceries'},adminToken);
  assert.equal(newProduct.status,201);
  const changed=await api(`/admin/products/${newProduct.data.id}`,'PATCH',{stock:9},adminToken);
  assert.equal(changed.status,200);
  const removed=await api(`/admin/products/${newProduct.data.id}`,'DELETE',null,adminToken);
  assert.equal(removed.status,200);

  const index=await fetch(base+'/');
  assert.equal(index.status,200);
  assert.ok((await index.text()).includes('Everything you love'));
  const traverse=await fetch(base+'/%2e%2e/%2e%2e/etc/passwd');
  assert.notEqual(traverse.status,200);
  const logout=await api('/auth/logout','POST',{},customerToken);
  assert.equal(logout.status,200);
  const expired=await api('/me','GET',null,customerToken);
  assert.equal(expired.status,401);
});

test.after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  rmSync(tempDir,{recursive:true,force:true});
});
