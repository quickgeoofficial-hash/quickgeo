/**
 * Quickgeo Backend Server v3.1
 * SQLite · Persistent Sessions · SSE Real-time · dotenv
 * + Rate limiting · Compression · Security headers · Indexes
 */
'use strict';
require('dotenv').config();
const express=require('express'),fs=require('fs'),path=require('path'),cors=require('cors'),crypto=require('crypto'),multer=require('multer'),compression=require('compression');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+ — no native compilation needed
const app=express();
const INSECURE=['Change_Me_Now@2025!','password','123456','admin','quickgeo_admin_2025',''];
const config={
  adminUsername:process.env.ADMIN_USERNAME||'quickgeo_admin',
  adminPassword:process.env.ADMIN_PASSWORD||'',
  port:parseInt(process.env.PORT||'3000',10),
  sessionHours:parseInt(process.env.SESSION_HOURS||'24',10),
  maxBodyMB:parseInt(process.env.MAX_BODY_MB||'10',10),
  allowedOrigins:(process.env.ALLOWED_ORIGINS||'https://quickgeo.live,https://www.quickgeo.live,http://localhost:3000,http://localhost:5500').split(',').map(s=>s.trim()),
};
if(!config.adminPassword||INSECURE.includes(config.adminPassword)){console.error('\n❌  Set ADMIN_PASSWORD in ~/quickgeo/.env\n');process.exit(1);}
const DATA_DIR=path.join(__dirname,'data'),UPLOADS_DIR=path.join(__dirname,'uploads');
[DATA_DIR,UPLOADS_DIR].forEach(d=>{if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true});});
const db=new DatabaseSync(path.join(DATA_DIR,'quickgeo.db'));
db.exec('PRAGMA journal_mode = WAL');db.exec('PRAGMA synchronous = NORMAL');
db.exec(`
CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY,tag TEXT NOT NULL,tagEmoji TEXT DEFAULT '',text TEXT DEFAULT '',media TEXT DEFAULT '[]',replyTo TEXT DEFAULT NULL,reactions TEXT DEFAULT '{}',reactUsers TEXT DEFAULT '{}',pinned INTEGER DEFAULT 0,time TEXT,date TEXT,createdAt TEXT,editedAt TEXT DEFAULT NULL);
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY AUTOINCREMENT,emoji TEXT DEFAULT '📌',name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_posts_pinned_id ON posts(pinned DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
CREATE INDEX IF NOT EXISTS idx_posts_tag ON posts(tag);
CREATE INDEX IF NOT EXISTS idx_posts_id_pinned0 ON posts(id DESC) WHERE pinned = 0;
`);
const DEFAULT_CATS=[{emoji:'🔴',name:'Breaking'},{emoji:'🗺',name:'Maps'},{emoji:'🛰',name:'Satellite'},{emoji:'🌐',name:'OSM'},{emoji:'📊',name:'Data'},{emoji:'✨',name:'Feature'},{emoji:'🔄',name:'Update'}];
if(db.prepare('SELECT COUNT(*) as n FROM categories').get().n===0){const ins=db.prepare('INSERT OR IGNORE INTO categories (emoji,name) VALUES (?,?)');DEFAULT_CATS.forEach(c=>ins.run(c.emoji,c.name));console.log('✅  Default categories seeded');}
(function migrate(){
  const pf=path.join(DATA_DIR,'posts.json'),cf=path.join(DATA_DIR,'categories.json');
  if(fs.existsSync(pf)){try{const posts=JSON.parse(fs.readFileSync(pf,'utf8'));const ins=db.prepare('INSERT OR IGNORE INTO posts(id,tag,tagEmoji,text,media,replyTo,reactions,reactUsers,pinned,time,date,createdAt,editedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');db.exec('BEGIN');try{posts.forEach(p=>ins.run(p.id,p.tag,p.tagEmoji||'',p.text||'',JSON.stringify(p.media||[]),p.replyTo?JSON.stringify(p.replyTo):null,JSON.stringify(p.reactions||{}),JSON.stringify(p.reactUsers||{}),p.pinned?1:0,p.time||'',p.date||'',p.createdAt||new Date().toISOString(),p.editedAt||null));db.exec('COMMIT');}catch(txErr){db.exec('ROLLBACK');throw txErr;}fs.renameSync(pf,pf+'.migrated');console.log(`✅  Migrated ${posts.length} posts`);}catch(e){console.warn('⚠️  posts.json migration:',e.message);}}
  if(fs.existsSync(cf)){try{const cats=JSON.parse(fs.readFileSync(cf,'utf8'));const ins=db.prepare('INSERT OR IGNORE INTO categories(emoji,name) VALUES(?,?)');cats.forEach(c=>ins.run(c.emoji||'📌',c.name));fs.renameSync(cf,cf+'.migrated');console.log('✅  Migrated categories');}catch(e){console.warn('⚠️  categories.json migration:',e.message);}}
})();
function parsePost(r){return{...r,media:JSON.parse(r.media||'[]'),replyTo:r.replyTo?JSON.parse(r.replyTo):null,reactions:JSON.parse(r.reactions||'{}'),reactUsers:JSON.parse(r.reactUsers||'{}'),pinned:!!r.pinned};}
const stmtPinned=db.prepare('SELECT * FROM posts WHERE pinned = 1 ORDER BY id DESC');
const getPinnedPosts=()=>stmtPinned.all().map(parsePost);
/* Paginated, filterable fetch of NON-pinned posts — this is what scales to lakhs of rows.
   before: cursor (post id) — return posts with id < before
   limit:  page size, capped at 100
   category: exact tag match
   search: substring match on text/tag (case-insensitive via LIKE + COLLATE NOCASE default) */
function getPostsPage({before, limit, category, search}) {
  limit = Math.min(Math.max(parseInt(limit)||20, 1), 100);
  let sql = 'SELECT * FROM posts WHERE pinned = 0';
  const params = [];
  if (before) { sql += ' AND id < ?'; params.push(Number(before)); }
  if (category) { sql += ' AND tag = ?'; params.push(category); }
  if (search) { sql += ' AND (text LIKE ? OR tag LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit + 1); // fetch one extra to detect if there's a next page
  const rows = db.prepare(sql).all(...params);
  const hasMore = rows.length > limit;
  return { posts: rows.slice(0, limit).map(parsePost), hasMore };
}
const getCats=()=>db.prepare('SELECT emoji,name FROM categories ORDER BY id').all();
setInterval(()=>db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()),3600000);
function createSession(){db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());const t=crypto.randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions(token,expires) VALUES(?,?)').run(t,Date.now()+config.sessionHours*3600000);return t;}
function isValidSession(t){if(!t)return false;const r=db.prepare('SELECT expires FROM sessions WHERE token=?').get(t);if(!r)return false;if(r.expires<Date.now()){db.prepare('DELETE FROM sessions WHERE token=?').run(t);return false;}return true;}
const storage=multer.diskStorage({destination:(req,file,cb)=>cb(null,UPLOADS_DIR),filename:(req,file,cb)=>{const ext=path.extname(file.originalname).toLowerCase();cb(null,`${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);}});
const upload=multer({storage,limits:{fileSize:50*1024*1024},fileFilter(req,file,cb){if(/image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime)/.test(file.mimetype))cb(null,true);else cb(new Error('File type not allowed'));}});
function delFile(url){if(!url||url.startsWith('data:'))return;try{const fn=url.split('/uploads/').pop();if(fn){const fp=path.join(UPLOADS_DIR,fn);if(fs.existsSync(fp))fs.unlinkSync(fp);}}catch{}}

/* ── MAGIC-BYTE VERIFICATION ──
   file.mimetype is CLIENT-SUPPLIED and trivially spoofable (a browser just
   reports whatever the file extension implies). This checks the actual
   file signature on disk so a renamed/disguised file can't slip past the
   mimetype allowlist — defense-in-depth against a stolen admin token or
   a future bug being used to plant a disguised file. */
function verifyMagicBytes(filePath,claimedMime){
  let fd;
  try{
    fd=fs.openSync(filePath,'r');
    const buf=Buffer.alloc(16);
    fs.readSync(fd,buf,0,16,0);
    fs.closeSync(fd);
    if(claimedMime==='image/jpeg')return buf[0]===0xFF&&buf[1]===0xD8&&buf[2]===0xFF;
    if(claimedMime==='image/png')return buf.toString('hex',0,4)==='89504e47';
    if(claimedMime==='image/gif')return buf.toString('ascii',0,6)==='GIF87a'||buf.toString('ascii',0,6)==='GIF89a';
    if(claimedMime==='image/webp')return buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP';
    if(claimedMime==='video/mp4')return buf.toString('ascii',4,8)==='ftyp';
    if(claimedMime==='video/quicktime')return buf.toString('ascii',4,8)==='ftyp'||buf.toString('ascii',4,8)==='moov'||buf.toString('ascii',4,8)==='free'||buf.toString('ascii',4,8)==='mdat'||buf.toString('ascii',4,8)==='wide';
    if(claimedMime==='video/webm')return buf.toString('hex',0,4)==='1a45dfa3';
    return false; // unknown claimed type — reject rather than assume safe
  }catch{ if(fd!==undefined)try{fs.closeSync(fd);}catch{} return false; }
}
const sseClients=new Set();
function broadcast(data){const msg=`data: ${JSON.stringify(data)}\n\n`;for(const r of sseClients){try{r.write(msg);}catch{sseClients.delete(r);}}}

/* ── RATE LIMITING (pure JS, no dependency, in-memory) ── */
const rateBuckets=new Map(); // key: `${ip}:${route}` -> {count, resetAt}
function rateLimit(routeKey,maxRequests,windowMs){
  return (req,res,next)=>{
    const ip=req.headers['cf-connecting-ip']||req.headers['x-forwarded-for']||req.ip||'unknown';
    const key=`${ip}:${routeKey}`;
    const now=Date.now();
    let bucket=rateBuckets.get(key);
    if(!bucket||bucket.resetAt<now){bucket={count:0,resetAt:now+windowMs};rateBuckets.set(key,bucket);}
    bucket.count++;
    if(bucket.count>maxRequests){
      const retryAfter=Math.ceil((bucket.resetAt-now)/1000);
      res.setHeader('Retry-After',retryAfter);
      return res.status(429).json({error:`Too many requests. Try again in ${retryAfter}s.`});
    }
    next();
  };
}
// Clean expired rate-limit buckets every 5 minutes to avoid memory growth
setInterval(()=>{const now=Date.now();for(const[k,v]of rateBuckets)if(v.resetAt<now)rateBuckets.delete(k);},300000);

/* ── ESCALATING LOGIN LOCKOUT ──
   Rate limit alone just makes an attacker wait out the window and resume.
   This tracks FAILED attempts specifically and escalates the lockout duration:
   5 fails → 15 min · 10 fails → 1 hour · 20 fails → 24 hours.
   Resets to zero on any successful login. */
const failedLogins=new Map(); // ip -> {count, lockUntil}
function getClientIp(req){return req.headers['cf-connecting-ip']||req.headers['x-forwarded-for']||req.ip||'unknown';}
function checkLoginLockout(ip){
  const rec=failedLogins.get(ip);
  if(!rec||!rec.lockUntil)return 0;
  if(rec.lockUntil>Date.now())return Math.ceil((rec.lockUntil-Date.now())/1000);
  return 0;
}
function recordFailedLogin(ip){
  const rec=failedLogins.get(ip)||{count:0,lockUntil:0};
  rec.count++;
  if(rec.count>=20)rec.lockUntil=Date.now()+24*3600000;
  else if(rec.count>=10)rec.lockUntil=Date.now()+3600000;
  else if(rec.count>=5)rec.lockUntil=Date.now()+15*60000;
  failedLogins.set(ip,rec);
}
function clearFailedLogins(ip){failedLogins.delete(ip);}
// Clean stale entries (no lockout active, low count) every hour to bound memory
setInterval(()=>{const now=Date.now();for(const[k,v]of failedLogins)if(v.lockUntil<now&&v.count<5)failedLogins.delete(k);},3600000);

/* ── INPUT LENGTH VALIDATION ──
   Caps on admin-supplied fields — defense-in-depth against abuse via a
   stolen/leaked session token, or simple future bugs, not just body-size limits. */
const LIMITS={tag:50,tagEmoji:20,text:5000,catName:50,catEmoji:20,replyText:200};
function tooLong(str,max){return typeof str==='string'&&str.length>max;}

/* ── SECURITY HEADERS (pure JS, no dependency) ──
   Note: these apply to API/JSON/media responses from THIS server.
   The HTML pages (index.html, admin panel) are served separately by
   Cloudflare Pages and need their own _headers file — see that file
   for CSP, Permissions-Policy, and the HTML-facing HSTS/X-Frame-Options. */
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection','1; mode=block');
  res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  res.removeHeader('X-Powered-By'); // don't advertise Express/version to attackers
  next();
});

app.use(compression()); // gzip all JSON/text responses — big bandwidth savings
app.use(cors({origin(origin,cb){if(!origin)return cb(null,true);if(config.allowedOrigins.includes(origin))return cb(null,true);cb(new Error(`CORS blocked: ${origin}`));},credentials:true}));
app.use(express.json({limit:`${config.maxBodyMB}mb`}));
app.use((req,_,next)=>{console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.path}`);next();});
app.use('/uploads',(req,res)=>{
  const fp=path.join(UPLOADS_DIR,path.basename(req.path));
  // Defense-in-depth: verify the resolved path is actually still inside
  // UPLOADS_DIR (path.basename already strips ../ segments, this catches
  // any edge case — e.g. encoded traversal — that might slip through)
  if(!path.resolve(fp).startsWith(path.resolve(UPLOADS_DIR)+path.sep))return res.status(400).json({error:'Invalid path'});
  if(!fs.existsSync(fp))return res.status(404).json({error:'Not found'});
  const stat=fs.statSync(fp),size=stat.size,ext=path.extname(fp).toLowerCase();
  const mime={'.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp'};
  const type=mime[ext]||'application/octet-stream',range=req.headers.range;
  if(range){const[s,e]=range.replace(/bytes=/,'').split('-'),start=parseInt(s,10),end=e?parseInt(e,10):size-1;res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${size}`,'Accept-Ranges':'bytes','Content-Length':end-start+1,'Content-Type':type,'Cache-Control':'public, max-age=86400'});fs.createReadStream(fp,{start,end}).pipe(res);}
  else{res.writeHead(200,{'Content-Length':size,'Content-Type':type,'Accept-Ranges':'bytes','Cache-Control':'public, max-age=86400'});fs.createReadStream(fp).pipe(res);}
});
function adminOnly(req,res,next){const auth=req.headers['authorization']||'',tok=auth.startsWith('Bearer ')?auth.slice(7):'';if(!isValidSession(tok))return res.status(401).json({error:'Session expired. Please log in again.'});next();}
app.get('/health',(req,res)=>res.json({status:'ok',server:'Quickgeo',version:'3.3.0',time:new Date().toISOString(),posts:db.prepare('SELECT COUNT(*) as n FROM posts').get().n,clients:sseClients.size}));
app.get('/api/stream',(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();res.write('data: {"type":"connected"}\n\n');sseClients.add(res);const hb=setInterval(()=>{try{res.write(': ping\n\n');}catch{}},25000);req.on('close',()=>{clearInterval(hb);sseClients.delete(res);});});
app.post('/api/upload',adminOnly,rateLimit('upload',30,10*60000),upload.single('file'),(req,res)=>{
  if(!req.file)return res.status(400).json({error:'No file received'});
  const isImg=req.file.mimetype.startsWith('image/'),max=isImg?5*1024*1024:50*1024*1024;
  if(req.file.size>max){fs.unlinkSync(req.file.path);return res.status(400).json({error:`Too large. Max ${isImg?'5MB images':'50MB video'}.`});}
  if(!verifyMagicBytes(req.file.path,req.file.mimetype)){
    fs.unlinkSync(req.file.path);
    console.warn(`[UPLOAD] Rejected — content does not match claimed type ${req.file.mimetype}: ${req.file.originalname}`);
    return res.status(400).json({error:'File content does not match its type. Upload rejected.'});
  }
  const protocol=req.headers['x-forwarded-proto']||req.protocol,host=req.headers['x-forwarded-host']||req.get('host'),url=`${protocol}://${host}/uploads/${req.file.filename}`;
  console.log(`[UPLOAD] ${req.file.filename} (${(req.file.size/1024/1024).toFixed(2)} MB)`);
  res.json({url,filename:req.file.filename,size:req.file.size,type:req.file.mimetype});
});
app.post('/api/login',rateLimit('login',5,15*60000),(req,res)=>{
  const ip=getClientIp(req);
  const lockedFor=checkLoginLockout(ip);
  if(lockedFor>0){
    res.setHeader('Retry-After',lockedFor);
    return res.status(429).json({error:`Too many failed attempts. Try again in ${Math.ceil(lockedFor/60)} min.`});
  }
  const{username,password}=req.body||{};
  if(username===config.adminUsername&&password===config.adminPassword){
    clearFailedLogins(ip);
    const tok=createSession();
    console.log(`[AUTH] Login OK: ${username}`);
    return res.json({token:tok,expiresIn:`${config.sessionHours}h`});
  }
  recordFailedLogin(ip);
  console.log(`[AUTH] Failed: ${username||'(blank)'} from ${ip}`);
  setTimeout(()=>res.status(401).json({error:'Invalid username or password.'}),1200);
});
app.post('/api/logout',(req,res)=>{const auth=req.headers['authorization']||'',tok=auth.startsWith('Bearer ')?auth.slice(7):'';db.prepare('DELETE FROM sessions WHERE token=?').run(tok);res.json({ok:true});});
app.post('/api/logout-all',adminOnly,(req,res)=>{
  // Invalidates EVERY active session, including the one making this request.
  // Use if a device is lost/stolen or a token may have leaked.
  const r=db.prepare('DELETE FROM sessions').run();
  console.log(`[AUTH] logout-all triggered — ${r.changes} session(s) invalidated`);
  res.json({ok:true,invalidated:r.changes});
});
app.get('/api/me',adminOnly,(req,res)=>res.json({ok:true,role:'admin'}));
app.get('/api/posts',(req,res)=>{
  const { before, limit, category, search } = req.query;
  const { posts, hasMore } = getPostsPage({ before, limit, category, search: search ? String(search).slice(0,100) : null });
  const safe = posts.map(({reactUsers,...p})=>p);
  res.json({ posts: safe, hasMore });
});
app.get('/api/posts/pinned',(req,res)=>{
  const pinned = getPinnedPosts().map(({reactUsers,...p})=>p);
  res.json(pinned);
});
app.post('/api/posts',adminOnly,(req,res)=>{
  const{tag,tagEmoji,text,media,replyTo}=req.body;
  if(!tag)return res.status(400).json({error:'tag is required'});
  if(tooLong(tag,LIMITS.tag))return res.status(400).json({error:`tag too long (max ${LIMITS.tag} chars)`});
  if(tooLong(tagEmoji,LIMITS.tagEmoji))return res.status(400).json({error:'tagEmoji too long'});
  if(tooLong(text,LIMITS.text))return res.status(400).json({error:`text too long (max ${LIMITS.text} chars)`});
  let sRT=null;if(replyTo&&typeof replyTo==='object'){const rid=Number(replyTo.id);if(rid)sRT={id:rid,text:String(replyTo.text||'').slice(0,LIMITS.replyText),tag:String(replyTo.tag||'').slice(0,LIMITS.tag),tagEmoji:String(replyTo.tagEmoji||'').slice(0,LIMITS.tagEmoji)};}
  const now=new Date(),id=Date.now();
  db.prepare("INSERT INTO posts(id,tag,tagEmoji,text,media,replyTo,reactions,reactUsers,pinned,time,date,createdAt) VALUES(?,?,?,?,?,?,'{}','{}',0,?,?,?)").run(id,tag,tagEmoji||'',text||'',JSON.stringify(Array.isArray(media)?media:[]),sRT?JSON.stringify(sRT):null,now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),now.toLocaleDateString(),now.toISOString());
  broadcast({type:'new_post',id});const post=parsePost(db.prepare('SELECT * FROM posts WHERE id=?').get(id));const{reactUsers,...safe}=post;res.status(201).json(safe);
});
app.delete('/api/posts/:id',adminOnly,(req,res)=>{const id=Number(req.params.id),row=db.prepare('SELECT media FROM posts WHERE id=?').get(id);if(!row)return res.status(404).json({error:'Post not found'});try{JSON.parse(row.media||'[]').forEach(m=>delFile(m.url));}catch{}db.prepare('DELETE FROM posts WHERE id=?').run(id);broadcast({type:'delete_post',id});res.json({ok:true});});
app.patch('/api/posts/:id/edit',adminOnly,(req,res)=>{
  const id=Number(req.params.id);
  if(!db.prepare('SELECT id FROM posts WHERE id=?').get(id))return res.status(404).json({error:'Post not found'});
  const{tag,tagEmoji,text}=req.body||{};
  if(tooLong(tag,LIMITS.tag))return res.status(400).json({error:`tag too long (max ${LIMITS.tag} chars)`});
  if(tooLong(tagEmoji,LIMITS.tagEmoji))return res.status(400).json({error:'tagEmoji too long'});
  if(tooLong(text,LIMITS.text))return res.status(400).json({error:`text too long (max ${LIMITS.text} chars)`});
  db.prepare('UPDATE posts SET tag=COALESCE(?,tag),tagEmoji=COALESCE(?,tagEmoji),text=COALESCE(?,text),editedAt=? WHERE id=?').run(tag||null,tagEmoji!=null?tagEmoji:null,text!=null?text:null,new Date().toISOString(),id);
  broadcast({type:'update_post',id});res.json({ok:true});
});
app.patch('/api/posts/:id/pin',adminOnly,(req,res)=>{const id=Number(req.params.id),row=db.prepare('SELECT pinned FROM posts WHERE id=?').get(id);if(!row)return res.status(404).json({error:'Post not found'});const p=row.pinned?0:1;db.prepare('UPDATE posts SET pinned=? WHERE id=?').run(p,id);broadcast({type:'update_post',id});res.json({ok:true,pinned:!!p});});
app.post('/api/posts/:id/react',rateLimit('react',60,60000),(req,res)=>{
  const{emoji,userId}=req.body||{};if(!emoji||!userId)return res.status(400).json({error:'emoji and userId required'});
  const AL=new Set(['👍','❤️','😂','😮','😢','😡','🔥','🎉','👏','🤔','🌍','💯']);if(!AL.has(emoji))return res.status(400).json({error:'Invalid emoji'});
  if(userId.length<8||userId.length>128||!/^[a-zA-Z0-9_-]+$/.test(userId))return res.status(400).json({error:'Invalid userId'});
  const row=db.prepare('SELECT reactions,reactUsers FROM posts WHERE id=?').get(Number(req.params.id));if(!row)return res.status(404).json({error:'Post not found'});
  const reactions=JSON.parse(row.reactions||'{}'),reactUsers=JSON.parse(row.reactUsers||'{}'),key=`${userId}_${emoji}`;let nr;
  if(reactUsers[key]){reactions[emoji]=Math.max(0,(reactions[emoji]||1)-1);if(!reactions[emoji])delete reactions[emoji];delete reactUsers[key];nr=false;}
  else{reactions[emoji]=(reactions[emoji]||0)+1;reactUsers[key]=true;nr=true;}
  db.prepare('UPDATE posts SET reactions=?,reactUsers=? WHERE id=?').run(JSON.stringify(reactions),JSON.stringify(reactUsers),Number(req.params.id));
  res.json({reactions,reacted:nr});
});
app.get('/api/categories',(_,res)=>res.json(getCats()));
app.post('/api/categories',adminOnly,(req,res)=>{
  const{emoji,name}=req.body||{};
  if(!name)return res.status(400).json({error:'name required'});
  if(tooLong(name,LIMITS.catName))return res.status(400).json({error:`name too long (max ${LIMITS.catName} chars)`});
  if(tooLong(emoji,LIMITS.catEmoji))return res.status(400).json({error:'emoji too long'});
  try{db.prepare('INSERT INTO categories(emoji,name) VALUES(?,?)').run(emoji||'📌',name);res.status(201).json({ok:true});}
  catch(e){if(e.message.includes('UNIQUE'))return res.status(409).json({error:'Category already exists'});res.status(500).json({error:'Failed to save category'});}
});
app.delete('/api/categories/:name',adminOnly,(req,res)=>{const r=db.prepare('DELETE FROM categories WHERE name=?').run(decodeURIComponent(req.params.name));if(r.changes===0)return res.status(404).json({error:'Category not found'});res.json({ok:true});});
app.listen(config.port,'0.0.0.0',()=>{
  console.log('\n╔══════════════════════════════════╗');
  console.log('║   Quickgeo Server v3.3 Running   ║');
  console.log('╚══════════════════════════════════╝');
  console.log(`\n✅  Port     → ${config.port}`);
  console.log(`👤  Username → ${config.adminUsername}`);
  console.log(`🔒  Password → *** (from .env)`);
  console.log(`🗄️   Database → ${path.join(DATA_DIR,'quickgeo.db')}`);
  console.log(`📁  Uploads  → ${UPLOADS_DIR}`);
  console.log(`🌐  Origins  → ${config.allowedOrigins.join(', ')}`);
  console.log(`🛡️   Hardening → rate-limit + gzip + security headers + indexes\n`);
});
