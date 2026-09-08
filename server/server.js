/**
 * Quickgeo Backend Server v3.0
 * SQLite · Persistent Sessions · SSE Real-time · dotenv
 */
'use strict';
require('dotenv').config();
const express=require('express'),fs=require('fs'),path=require('path'),cors=require('cors'),crypto=require('crypto'),multer=require('multer');
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
`);
const DEFAULT_CATS=[{emoji:'🔴',name:'Breaking'},{emoji:'🗺',name:'Maps'},{emoji:'🛰',name:'Satellite'},{emoji:'🌐',name:'OSM'},{emoji:'📊',name:'Data'},{emoji:'✨',name:'Feature'},{emoji:'🔄',name:'Update'}];
if(db.prepare('SELECT COUNT(*) as n FROM categories').get().n===0){const ins=db.prepare('INSERT OR IGNORE INTO categories (emoji,name) VALUES (?,?)');DEFAULT_CATS.forEach(c=>ins.run(c.emoji,c.name));console.log('✅  Default categories seeded');}
(function migrate(){
  const pf=path.join(DATA_DIR,'posts.json'),cf=path.join(DATA_DIR,'categories.json');
  if(fs.existsSync(pf)){try{const posts=JSON.parse(fs.readFileSync(pf,'utf8'));const ins=db.prepare('INSERT OR IGNORE INTO posts(id,tag,tagEmoji,text,media,replyTo,reactions,reactUsers,pinned,time,date,createdAt,editedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');db.exec('BEGIN');try{posts.forEach(p=>ins.run(p.id,p.tag,p.tagEmoji||'',p.text||'',JSON.stringify(p.media||[]),p.replyTo?JSON.stringify(p.replyTo):null,JSON.stringify(p.reactions||{}),JSON.stringify(p.reactUsers||{}),p.pinned?1:0,p.time||'',p.date||'',p.createdAt||new Date().toISOString(),p.editedAt||null));db.exec('COMMIT');}catch(txErr){db.exec('ROLLBACK');throw txErr;}fs.renameSync(pf,pf+'.migrated');console.log(`✅  Migrated ${posts.length} posts`);}catch(e){console.warn('⚠️  posts.json migration:',e.message);}}
  if(fs.existsSync(cf)){try{const cats=JSON.parse(fs.readFileSync(cf,'utf8'));const ins=db.prepare('INSERT OR IGNORE INTO categories(emoji,name) VALUES(?,?)');cats.forEach(c=>ins.run(c.emoji||'📌',c.name));fs.renameSync(cf,cf+'.migrated');console.log('✅  Migrated categories');}catch(e){console.warn('⚠️  categories.json migration:',e.message);}}
})();
function parsePost(r){return{...r,media:JSON.parse(r.media||'[]'),replyTo:r.replyTo?JSON.parse(r.replyTo):null,reactions:JSON.parse(r.reactions||'{}'),reactUsers:JSON.parse(r.reactUsers||'{}'),pinned:!!r.pinned};}
const stmtAll=db.prepare('SELECT * FROM posts ORDER BY pinned DESC, id DESC');
const getPosts=()=>stmtAll.all().map(parsePost);
const getCats=()=>db.prepare('SELECT emoji,name FROM categories ORDER BY id').all();
setInterval(()=>db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()),3600000);
function createSession(){db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());const t=crypto.randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions(token,expires) VALUES(?,?)').run(t,Date.now()+config.sessionHours*3600000);return t;}
function isValidSession(t){if(!t)return false;const r=db.prepare('SELECT expires FROM sessions WHERE token=?').get(t);if(!r)return false;if(r.expires<Date.now()){db.prepare('DELETE FROM sessions WHERE token=?').run(t);return false;}return true;}
const storage=multer.diskStorage({destination:(req,file,cb)=>cb(null,UPLOADS_DIR),filename:(req,file,cb)=>{const ext=path.extname(file.originalname).toLowerCase();cb(null,`${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);}});
const upload=multer({storage,limits:{fileSize:50*1024*1024},fileFilter(req,file,cb){if(/image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime)/.test(file.mimetype))cb(null,true);else cb(new Error('File type not allowed'));}});
function delFile(url){if(!url||url.startsWith('data:'))return;try{const fn=url.split('/uploads/').pop();if(fn){const fp=path.join(UPLOADS_DIR,fn);if(fs.existsSync(fp))fs.unlinkSync(fp);}}catch{}}
const sseClients=new Set();
function broadcast(data){const msg=`data: ${JSON.stringify(data)}\n\n`;for(const r of sseClients){try{r.write(msg);}catch{sseClients.delete(r);}}}
app.use(cors({origin(origin,cb){if(!origin)return cb(null,true);if(config.allowedOrigins.includes(origin))return cb(null,true);cb(new Error(`CORS blocked: ${origin}`));},credentials:true}));
app.use(express.json({limit:`${config.maxBodyMB}mb`}));
app.use((req,_,next)=>{console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.path}`);next();});
app.use('/uploads',(req,res)=>{
  const fp=path.join(UPLOADS_DIR,path.basename(req.path));if(!fs.existsSync(fp))return res.status(404).json({error:'Not found'});
  const stat=fs.statSync(fp),size=stat.size,ext=path.extname(fp).toLowerCase();
  const mime={'.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp'};
  const type=mime[ext]||'application/octet-stream',range=req.headers.range;
  if(range){const[s,e]=range.replace(/bytes=/,'').split('-'),start=parseInt(s,10),end=e?parseInt(e,10):size-1;res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${size}`,'Accept-Ranges':'bytes','Content-Length':end-start+1,'Content-Type':type,'Cache-Control':'public, max-age=86400'});fs.createReadStream(fp,{start,end}).pipe(res);}
  else{res.writeHead(200,{'Content-Length':size,'Content-Type':type,'Accept-Ranges':'bytes','Cache-Control':'public, max-age=86400'});fs.createReadStream(fp).pipe(res);}
});
function adminOnly(req,res,next){const auth=req.headers['authorization']||'',tok=auth.startsWith('Bearer ')?auth.slice(7):'';if(!isValidSession(tok))return res.status(401).json({error:'Session expired. Please log in again.'});next();}
app.get('/health',(req,res)=>res.json({status:'ok',server:'Quickgeo',version:'3.0.0',time:new Date().toISOString(),posts:db.prepare('SELECT COUNT(*) as n FROM posts').get().n,clients:sseClients.size}));
app.get('/api/stream',(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();res.write('data: {"type":"connected"}\n\n');sseClients.add(res);const hb=setInterval(()=>{try{res.write(': ping\n\n');}catch{}},25000);req.on('close',()=>{clearInterval(hb);sseClients.delete(res);});});
app.post('/api/upload',adminOnly,upload.single('file'),(req,res)=>{if(!req.file)return res.status(400).json({error:'No file received'});const isImg=req.file.mimetype.startsWith('image/'),max=isImg?5*1024*1024:50*1024*1024;if(req.file.size>max){fs.unlinkSync(req.file.path);return res.status(400).json({error:`Too large. Max ${isImg?'5MB images':'50MB video'}.`});}const protocol=req.headers['x-forwarded-proto']||req.protocol,host=req.headers['x-forwarded-host']||req.get('host'),url=`${protocol}://${host}/uploads/${req.file.filename}`;console.log(`[UPLOAD] ${req.file.filename} (${(req.file.size/1024/1024).toFixed(2)} MB)`);res.json({url,filename:req.file.filename,size:req.file.size,type:req.file.mimetype});});
app.post('/api/login',(req,res)=>{const{username,password}=req.body||{};if(username===config.adminUsername&&password===config.adminPassword){const tok=createSession();console.log(`[AUTH] Login OK: ${username}`);return res.json({token:tok,expiresIn:`${config.sessionHours}h`});}console.log(`[AUTH] Failed: ${username||'(blank)'}`);setTimeout(()=>res.status(401).json({error:'Invalid username or password.'}),1200);});
app.post('/api/logout',(req,res)=>{const auth=req.headers['authorization']||'',tok=auth.startsWith('Bearer ')?auth.slice(7):'';db.prepare('DELETE FROM sessions WHERE token=?').run(tok);res.json({ok:true});});
app.get('/api/me',adminOnly,(req,res)=>res.json({ok:true,role:'admin'}));
app.get('/api/posts',(req,res)=>{const posts=getPosts().map(({reactUsers,...p})=>p);res.json(posts);});
app.post('/api/posts',adminOnly,(req,res)=>{
  const{tag,tagEmoji,text,media,replyTo}=req.body;if(!tag)return res.status(400).json({error:'tag is required'});
  let sRT=null;if(replyTo&&typeof replyTo==='object'){const rid=Number(replyTo.id);if(rid)sRT={id:rid,text:String(replyTo.text||'').slice(0,200),tag:String(replyTo.tag||''),tagEmoji:String(replyTo.tagEmoji||'')};}
  const now=new Date(),id=Date.now();
  db.prepare("INSERT INTO posts(id,tag,tagEmoji,text,media,replyTo,reactions,reactUsers,pinned,time,date,createdAt) VALUES(?,?,?,?,?,?,'{}','{}',0,?,?,?)").run(id,tag,tagEmoji||'',text||'',JSON.stringify(Array.isArray(media)?media:[]),sRT?JSON.stringify(sRT):null,now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),now.toLocaleDateString(),now.toISOString());
  broadcast({type:'new_post',id});const post=parsePost(db.prepare('SELECT * FROM posts WHERE id=?').get(id));const{reactUsers,...safe}=post;res.status(201).json(safe);
});
app.delete('/api/posts/:id',adminOnly,(req,res)=>{const id=Number(req.params.id),row=db.prepare('SELECT media FROM posts WHERE id=?').get(id);if(!row)return res.status(404).json({error:'Post not found'});try{JSON.parse(row.media||'[]').forEach(m=>delFile(m.url));}catch{}db.prepare('DELETE FROM posts WHERE id=?').run(id);broadcast({type:'delete_post',id});res.json({ok:true});});
app.patch('/api/posts/:id/edit',adminOnly,(req,res)=>{const id=Number(req.params.id);if(!db.prepare('SELECT id FROM posts WHERE id=?').get(id))return res.status(404).json({error:'Post not found'});const{tag,tagEmoji,text}=req.body||{};db.prepare('UPDATE posts SET tag=COALESCE(?,tag),tagEmoji=COALESCE(?,tagEmoji),text=COALESCE(?,text),editedAt=? WHERE id=?').run(tag||null,tagEmoji!=null?tagEmoji:null,text!=null?text:null,new Date().toISOString(),id);broadcast({type:'update_post',id});res.json({ok:true});});
app.patch('/api/posts/:id/pin',adminOnly,(req,res)=>{const id=Number(req.params.id),row=db.prepare('SELECT pinned FROM posts WHERE id=?').get(id);if(!row)return res.status(404).json({error:'Post not found'});const p=row.pinned?0:1;db.prepare('UPDATE posts SET pinned=? WHERE id=?').run(p,id);broadcast({type:'update_post',id});res.json({ok:true,pinned:!!p});});
app.post('/api/posts/:id/react',(req,res)=>{
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
app.post('/api/categories',adminOnly,(req,res)=>{const{emoji,name}=req.body||{};if(!name)return res.status(400).json({error:'name required'});try{db.prepare('INSERT INTO categories(emoji,name) VALUES(?,?)').run(emoji||'📌',name);res.status(201).json({ok:true});}catch(e){if(e.message.includes('UNIQUE'))return res.status(409).json({error:'Category already exists'});res.status(500).json({error:'Failed to save category'});}});
app.delete('/api/categories/:name',adminOnly,(req,res)=>{const r=db.prepare('DELETE FROM categories WHERE name=?').run(decodeURIComponent(req.params.name));if(r.changes===0)return res.status(404).json({error:'Category not found'});res.json({ok:true});});
app.listen(config.port,'0.0.0.0',()=>{
  console.log('\n╔══════════════════════════════════╗');
  console.log('║   Quickgeo Server v3.0 Running   ║');
  console.log('╚══════════════════════════════════╝');
  console.log(`\n✅  Port     → ${config.port}`);
  console.log(`👤  Username → ${config.adminUsername}`);
  console.log(`🔒  Password → *** (from .env)`);
  console.log(`🗄️   Database → ${path.join(DATA_DIR,'quickgeo.db')}`);
  console.log(`📁  Uploads  → ${UPLOADS_DIR}`);
  console.log(`🌐  Origins  → ${config.allowedOrigins.join(', ')}\n`);
});
