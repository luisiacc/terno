import {createRequire} from 'node:module';
const require=createRequire(process.cwd()+'/apps/web/package.json');
const {chromium,expect}=require('@playwright/test');
const AxeBuilder=require('@axe-core/playwright').default;
const output=process.env.CAPTURE_OUTPUT ?? '/tmp/terno-w10-repair';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:900,height:720},serviceWorkers:'block'});
const page=await context.newPage(), errors=[], denied=[];
page.on('pageerror',e=>errors.push(e.message));
await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname!=='127.0.0.1'){denied.push(url.origin);return route.abort();}return route.continue();});
try {
 await page.goto('http://127.0.0.1:61810/e2e/fixtures/capture-recovery/index.html');
 await expect(page.getByRole('button',{name:'Messages needing repair'})).toBeVisible({timeout:30000});
 await page.keyboard.press('Tab'); await expect(page.getByRole('button',{name:'Messages needing repair'})).toBeFocused();
 await page.keyboard.press('Enter');
 await expect(page.getByText('This message has too many parts to process safely.')).toBeVisible();
 for(const mode of ['light','dark']){
  await page.evaluate(mode=>{document.documentElement.dataset.theme='lumen-'+mode;document.documentElement.classList.toggle('dark',mode==='dark');},mode);
  await page.evaluate(async()=>{void document.body.offsetWidth;await Promise.all(document.getAnimations().map(a=>a.finished));});
  const results=await new AxeBuilder({page}).analyze();expect(results.violations).toEqual([]);
  await page.screenshot({path:output+'/capture-'+mode+'.png'});
 }
 await page.evaluate(()=>window.captureHarness.close());
 await page.reload();await page.getByRole('button',{name:'Messages needing repair'}).click();
 await expect(page.getByText('This message has too many parts to process safely.')).toBeVisible();
 await page.evaluate(()=>window.captureHarness.valid());
 await page.getByRole('button',{name:'Retry',exact:true}).focus();await page.keyboard.press('Enter');
 await expect(page.getByText('No longer needs repair.')).toBeVisible();
 await expect(page.getByRole('button',{name:'Retry',exact:true})).toBeFocused();
 expect(errors).toEqual([]);expect(denied).toEqual([]);
 await page.evaluate(()=>window.captureHarness.close());
 console.log('PASS real worker healthy/reopen discovery, retry, keyboard/focus, light+dark axe and captures; 0 unexpected routes/page errors');
} finally {console.log(JSON.stringify({errors,denied}));await context.close();await browser.close();}
