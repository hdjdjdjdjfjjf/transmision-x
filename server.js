import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express(), PORT=process.env.PORT||3000, SECRET=process.env.JWT_SECRET||'dev-secret-change-me';
const dataDir=path.join(__dirname,'data'), uploadDir=path.join(__dirname,'uploads');
fs.mkdirSync(dataDir,{recursive:true}); fs.mkdirSync(uploadDir,{recursive:true});
const db=new Database(path.join(dataDir,'transmisionx.db'));
db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,bio TEXT DEFAULT '',avatar TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS videos(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,filename TEXT NOT NULL,caption TEXT DEFAULT '',views INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS likes(user_id INTEGER NOT NULL,video_id INTEGER NOT NULL,PRIMARY KEY(user_id,video_id),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,video_id INTEGER NOT NULL,text TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS follows(follower_id INTEGER NOT NULL,following_id INTEGER NOT NULL,PRIMARY KEY(follower_id,following_id),CHECK(follower_id<>following_id),FOREIGN KEY(follower_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(following_id) REFERENCES users(id) ON DELETE CASCADE);
`);
app.use(express.json({limit:'1mb'})); app.use(cookieParser()); app.use(express.static(path.join(__dirname,'public'))); app.use('/uploads',express.static(uploadDir));

function token(user){return jwt.sign({id:user.id,username:user.username},SECRET,{expiresIn:'7d'})}
function auth(req,res,next){try{const t=req.cookies.tx_token; if(!t) return res.status(401).json({error:'Inicia sesión'}); req.user=jwt.verify(t,SECRET); next()}catch{return res.status(401).json({error:'Sesión inválida'})}}
function safeUser(id){return db.prepare('SELECT id,username,email,bio,avatar,created_at FROM users WHERE id=?').get(id)}

app.post('/api/auth/register',async(req,res)=>{const {username,email,password}=req.body; if(!/^\w{3,20}$/.test(username||''))return res.status(400).json({error:'Usuario: 3-20 caracteres, letras/números/_'}); if(!/^\S+@\S+\.\S+$/.test(email||''))return res.status(400).json({error:'Correo inválido'}); if((password||'').length<6)return res.status(400).json({error:'Contraseña mínima de 6 caracteres'}); try{const hash=await bcrypt.hash(password,12);const r=db.prepare('INSERT INTO users(username,email,password_hash) VALUES(?,?,?)').run(username.toLowerCase(),email.toLowerCase(),hash);const u=safeUser(r.lastInsertRowid);res.cookie('tx_token',token(u),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:604800000});res.json({user:u})}catch(e){res.status(409).json({error:'Usuario o correo ya registrado'})}});
app.post('/api/auth/login',async(req,res)=>{const {email,password}=req.body||{};const u=db.prepare('SELECT * FROM users WHERE email=?').get((email||'').toLowerCase());if(!u||!(await bcrypt.compare(password||'',u.password_hash)))return res.status(401).json({error:'Correo o contraseña incorrectos'});res.cookie('tx_token',token(u),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:604800000});res.json({user:safeUser(u.id)})});
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('tx_token');res.json({ok:true})});
app.get('/api/me',(req,res)=>{try{const t=req.cookies.tx_token;if(!t)return res.status(401).json({error:'no-session'});const p=jwt.verify(t,SECRET);res.json({user:safeUser(p.id)})}catch{res.status(401).json({error:'no-session'})}});

const storage=multer.diskStorage({destination:uploadDir,filename:(req,file,cb)=>{const ext=path.extname(file.originalname).toLowerCase();cb(null,Date.now()+'-'+Math.random().toString(36).slice(2)+ext)}});
const upload=multer({storage,limits:{fileSize:(Number(process.env.MAX_VIDEO_MB)||100)*1024*1024},fileFilter:(req,file,cb)=>cb(null,/^video\/(mp4|webm|quicktime|x-matroska)$/.test(file.mimetype))});
app.post('/api/videos',auth,upload.single('video'),(req,res)=>{if(!req.file)return res.status(400).json({error:'Selecciona un video MP4, WebM o MOV'});const r=db.prepare('INSERT INTO videos(user_id,filename,caption) VALUES(?,?,?)').run(req.user.id,req.file.filename,(req.body.caption||'').slice(0,300));res.status(201).json(video(r.lastInsertRowid,req.user.id))});

function video(id,viewerId=0){const v=db.prepare(`SELECT v.*,u.username,u.avatar,(SELECT COUNT(*) FROM likes l WHERE l.video_id=v.id) likes,(SELECT COUNT(*) FROM comments c WHERE c.video_id=v.id) comments,(SELECT COUNT(*) FROM likes l WHERE l.video_id=v.id AND l.user_id=?) liked FROM videos v JOIN users u ON u.id=v.user_id WHERE v.id=?`).get(viewerId,id);if(v)v.videoUrl='/uploads/'+v.filename;delete v.filename;return v}
app.get('/api/videos',(req,res)=>{let viewer=0;try{if(req.cookies.tx_token)viewer=jwt.verify(req.cookies.tx_token,SECRET).id}catch{} const rows=db.prepare('SELECT id FROM videos ORDER BY id DESC LIMIT 100').all();res.json(rows.map(x=>video(x.id,viewer)))});
app.post('/api/videos/:id/view',(req,res)=>{db.prepare('UPDATE videos SET views=views+1 WHERE id=?').run(req.params.id);res.json({ok:true})});
app.post('/api/videos/:id/like',auth,(req,res)=>{const id=Number(req.params.id);const exists=db.prepare('SELECT 1 FROM likes WHERE user_id=? AND video_id=?').get(req.user.id,id);if(exists)db.prepare('DELETE FROM likes WHERE user_id=? AND video_id=?').run(req.user.id,id);else db.prepare('INSERT INTO likes(user_id,video_id) VALUES(?,?)').run(req.user.id,id);res.json(video(id,req.user.id))});
app.get('/api/videos/:id/comments',(req,res)=>res.json(db.prepare('SELECT c.id,c.text,c.created_at,u.username,u.avatar FROM comments c JOIN users u ON u.id=c.user_id WHERE c.video_id=? ORDER BY c.id DESC').all(req.params.id)));
app.post('/api/videos/:id/comments',auth,(req,res)=>{const text=(req.body.text||'').trim();if(!text||text.length>500)return res.status(400).json({error:'Comentario inválido'});const r=db.prepare('INSERT INTO comments(user_id,video_id,text) VALUES(?,?,?)').run(req.user.id,req.params.id,text);res.status(201).json(db.prepare('SELECT c.id,c.text,c.created_at,u.username,u.avatar FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=?').get(r.lastInsertRowid))});
app.get('/api/users/:username',(req,res)=>{const u=db.prepare('SELECT id,username,bio,avatar,created_at FROM users WHERE username=?').get(req.params.username.toLowerCase());if(!u)return res.status(404).json({error:'No encontrado'});u.followers=db.prepare('SELECT COUNT(*) n FROM follows WHERE following_id=?').get(u.id).n;u.following=db.prepare('SELECT COUNT(*) n FROM follows WHERE follower_id=?').get(u.id).n;u.videos=db.prepare('SELECT COUNT(*) n FROM videos WHERE user_id=?').get(u.id).n;res.json(u)});
app.post('/api/users/:id/follow',auth,(req,res)=>{const id=Number(req.params.id);if(id===req.user.id)return res.status(400).json({error:'No puedes seguirte'});const e=db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?').get(req.user.id,id);if(e)db.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').run(req.user.id,id);else db.prepare('INSERT INTO follows VALUES(?,?)').run(req.user.id,id);res.json({following:!e})});

app.get('/{*splat}',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Error interno'})});
app.listen(PORT,()=>console.log('Transmisión X en http://localhost:'+PORT));
