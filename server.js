import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createClient } from '@supabase/supabase-js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
const PORT=process.env.PORT||3000;
const SUPABASE_URL=process.env.SUPABASE_URL||'https://ebcerirjvbxuykfgczey.supabase.co';
const SUPABASE_KEY=process.env.SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_ANON_KEY;

if(!SUPABASE_KEY) console.warn('Missing SUPABASE_PUBLISHABLE_KEY/SUPABASE_ANON_KEY');

const supabase=createClient(SUPABASE_URL,SUPABASE_KEY);
app.use(express.json({limit:'1mb'}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public')));

function clientFor(req){
  const token=req.cookies.tx_access;
  return token ? createClient(SUPABASE_URL,SUPABASE_KEY,{global:{headers:{Authorization:'Bearer '+token}}}) : supabase;
}
async function auth(req,res,next){
  const c=clientFor(req);
  const {data:{user},error}=await c.auth.getUser();
  if(error||!user)return res.status(401).json({error:'Inicia sesión'});
  req.sb=c; req.user=user; next();
}
function cookieOpts(maxAge){return {httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge,path:'/'}}

app.post('/api/auth/register',async(req,res)=>{
  const username=(req.body.username||'').trim().replace(/^@/,'').toLowerCase();
  const email=(req.body.email||'').trim().toLowerCase();
  const password=req.body.password||'';
  if(!/^\\w{3,20}$/.test(username))return res.status(400).json({error:'Usuario: 3-20 caracteres, letras/números/_'});
  if(!/^\\S+@\\S+\\.\\S+$/.test(email))return res.status(400).json({error:'Correo inválido'});
  if(password.length<6)return res.status(400).json({error:'Contraseña mínima de 6 caracteres'});
  const {data,error}=await supabase.auth.signUp({email,password,options:{data:{username}}});
  if(error)return res.status(400).json({error:error.message});
  if(!data.user)return res.status(400).json({error:'No se pudo crear la cuenta'});
  if(data.session){
    res.cookie('tx_access',data.session.access_token,cookieOpts(604800000));
    res.cookie('tx_refresh',data.session.refresh_token,cookieOpts(2592000000));
  }
  const {data:profile}=await supabase.from('profiles').select('*').eq('id',data.user.id).maybeSingle();
  res.json({user:profile||{id:data.user.id,username},requiresEmailConfirmation:!data.session});
});

app.post('/api/auth/login',async(req,res)=>{
  const email=(req.body.email||'').trim().toLowerCase(),password=req.body.password||'';
  const {data,error}=await supabase.auth.signInWithPassword({email,password});
  if(error||!data.session)return res.status(401).json({error:'Correo o contraseña incorrectos'});
  res.cookie('tx_access',data.session.access_token,cookieOpts(604800000));
  res.cookie('tx_refresh',data.session.refresh_token,cookieOpts(2592000000));
  const {data:profile}=await supabase.from('profiles').select('*').eq('id',data.user.id).single();
  res.json({user:profile});
});

app.post('/api/auth/logout',async(req,res)=>{
  try{await clientFor(req).auth.signOut()}catch{}
  res.clearCookie('tx_access',{path:'/'});res.clearCookie('tx_refresh',{path:'/'});
  res.json({ok:true});
});

app.get('/api/me',async(req,res)=>{
  const c=clientFor(req); const {data:{user}}=await c.auth.getUser();
  if(!user)return res.status(401).json({error:'no-session'});
  const {data:profile}=await c.from('profiles').select('*').eq('id',user.id).single();
  res.json({user:profile});
});

const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:(Number(process.env.MAX_VIDEO_MB)||100)*1024*1024},fileFilter:(req,file,cb)=>cb(null,/^video\\/(mp4|webm|quicktime)$/.test(file.mimetype))});

async function formatVideos(rows,viewerId){
  const ids=rows.map(v=>v.id);
  let liked=new Set();
  if(viewerId&&ids.length){const {data}=await supabase.from('likes').select('video_id').eq('user_id',viewerId).in('video_id',ids);liked=new Set((data||[]).map(x=>x.video_id))}
  return rows.map(v=>({...v,username:v.profiles?.username,avatar:v.profiles?.avatar_url,videoUrl:supabase.storage.from('videos').getPublicUrl(v.storage_path).data.publicUrl,liked:liked.has(v.id)}));
}

app.get('/api/videos',async(req,res)=>{
  const c=clientFor(req);const {data:{user}}=await c.auth.getUser();
  const {data,error}=await supabase.from('videos').select('id,user_id,storage_path,caption,views,created_at,profiles(username,avatar_url),likes(count),comments(count)').order('created_at',{ascending:false}).limit(100);
  if(error)return res.status(500).json({error:error.message});
  res.json(await formatVideos(data||[],user?.id));
});

app.post('/api/videos',auth,upload.single('video'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Selecciona un video MP4, WebM o MOV'});
  const ext=path.extname(req.file.originalname).toLowerCase()||'.mp4';
  const storagePath=req.user.id+'/'+Date.now()+'-'+Math.random().toString(36).slice(2)+ext;
  const {error:upError}=await req.sb.storage.from('videos').upload(storagePath,req.file.buffer,{contentType:req.file.mimetype,upsert:false});
  if(upError)return res.status(400).json({error:upError.message});
  const {data,error}=await req.sb.from('videos').insert({user_id:req.user.id,storage_path:storagePath,caption:(req.body.caption||'').slice(0,300)}).select('id,user_id,storage_path,caption,views,created_at,profiles(username,avatar_url)').single();
  if(error){await req.sb.storage.from('videos').remove([storagePath]);return res.status(400).json({error:error.message})}
  res.status(201).json((await formatVideos([data],req.user.id))[0]);
});

app.post('/api/videos/:id/view',async(req,res)=>{
  const {error}=await supabase.rpc('increment_video_views',{video_id:BigInt(req.params.id).toString()});
  if(error)return res.status(400).json({error:error.message});res.json({ok:true});
});

app.post('/api/videos/:id/like',auth,async(req,res)=>{
  const id=Number(req.params.id);
  const {data:existing}=await req.sb.from('likes').select('video_id').eq('user_id',req.user.id).eq('video_id',id).maybeSingle();
  if(existing)await req.sb.from('likes').delete().eq('user_id',req.user.id).eq('video_id',id);
  else {const {error}=await req.sb.from('likes').insert({user_id:req.user.id,video_id:id});if(error)return res.status(400).json({error:error.message})}
  const {data:v}=await supabase.from('videos').select('id,user_id,storage_path,caption,views,created_at,profiles(username,avatar_url),likes(count),comments(count)').eq('id',id).single();
  res.json((await formatVideos([v],req.user.id))[0]);
});

app.get('/api/videos/:id/comments',async(req,res)=>{
  const {data,error}=await supabase.from('comments').select('id,text,created_at,profiles(username,avatar_url)').eq('video_id',Number(req.params.id)).order('created_at',{ascending:false});
  if(error)return res.status(400).json({error:error.message});
  res.json((data||[]).map(c=>({...c,username:c.profiles?.username,avatar:c.profiles?.avatar_url})));
});
app.post('/api/videos/:id/comments',auth,async(req,res)=>{
  const text=(req.body.text||'').trim();if(!text||text.length>500)return res.status(400).json({error:'Comentario inválido'});
  const {data,error}=await req.sb.from('comments').insert({user_id:req.user.id,video_id:Number(req.params.id),text}).select('id,text,created_at,profiles(username,avatar_url)').single();
  if(error)return res.status(400).json({error:error.message});
  res.status(201).json({...data,username:data.profiles?.username,avatar:data.profiles?.avatar_url});
});

app.get('/api/users/:username',async(req,res)=>{
  const {data:u}=await supabase.from('profiles').select('*').eq('username',req.params.username.toLowerCase()).maybeSingle();
  if(!u)return res.status(404).json({error:'No encontrado'});
  const [followers,following,videos]=await Promise.all([
    supabase.from('follows').select('*',{count:'exact',head:true}).eq('following_id',u.id),
    supabase.from('follows').select('*',{count:'exact',head:true}).eq('follower_id',u.id),
    supabase.from('videos').select('*',{count:'exact',head:true}).eq('user_id',u.id)
  ]);
  res.json({...u,followers:followers.count||0,following:following.count||0,videos:videos.count||0});
});
app.post('/api/users/:id/follow',auth,async(req,res)=>{
  const id=req.params.id;if(id===req.user.id)return res.status(400).json({error:'No puedes seguirte'});
  const {data:e}=await req.sb.from('follows').select('*').eq('follower_id',req.user.id).eq('following_id',id).maybeSingle();
  if(e)await req.sb.from('follows').delete().eq('follower_id',req.user.id).eq('following_id',id);
  else {const {error}=await req.sb.from('follows').insert({follower_id:req.user.id,following_id:id});if(error)return res.status(400).json({error:error.message})}
  res.json({following:!e});
});

app.get('/{*splat}',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Error interno'})});
app.listen(PORT,()=>console.log('Transmisión X en http://localhost:'+PORT));
