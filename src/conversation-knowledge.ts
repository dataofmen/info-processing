import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { config } from './config.ts';
import { ensureDir, now, readJson, writeJson, stringifyDoc, writeFile, slugify } from './util.ts';
import * as S from './query.ts';

export type Kind = 'insight' | 'decision' | 'playbook' | 'experiment' | 'outcome' | 'open_issue';
export type Candidate = {
 id: string; kind: Kind; project: string; title: string; content: string;
 evidence: string[]; conversation_ref?: string; status: 'pending'|'approved'|'rejected';
 created_at: string; reviewed_at?: string; note_path?: string; duplicate_of?: string;
};
const directory = () => process.env.CONVERSATION_CANDIDATE_DIR || path.join(config.root,'data','conversation-candidates');
const location = (id:string) => {
 if(!/^conv-[a-f0-9-]{36}$/.test(id)) throw new Error('잘못된 ID');
 return path.join(directory(),id+'.json');
};
const digest = (s:string) => createHash('sha256').update(s.normalize('NFC').replace(/\s+/g,' ').trim().toLowerCase()).digest('hex');
const all = ():Candidate[] => {
 ensureDir(directory());
 return fs.readdirSync(directory()).filter(x=>/^conv-[a-f0-9-]{36}\.json$/.test(x)).map(x=>readJson<Candidate|null>(path.join(directory(),x),null)).filter((x):x is Candidate=>!!x);
};
export const listCandidates = (status?:string) => all().filter(x=>!status||x.status===status).map(x=>({ ...x,content:x.content.slice(0,2000) }));
export const getCandidate = (id:string) => readJson<Candidate|null>(location(id),null);
export async function propose(input:{kind:Kind;project:string;title:string;content:string;evidence?:string[];conversation_ref?:string}){
 const title=input.title.trim(),content=input.content.trim(),project=input.project.trim();
 if(title.length<5 || content.length<15 || !project) throw new Error('제목(5자), 본문(15자), 프로젝트 필수');
 if(title.length>220||content.length>12000||(input.evidence||[]).length>20) throw new Error('크기 제한 초과');
 const evidence=(input.evidence||[]).filter(x=>x.length<=500);
 const fp=digest([project,title,content].join('|'));
 const same=all().find(x=>digest([x.project,x.title,x.content].join('|'))===fp);
 if(same) return {status:'duplicate',id:same.id,existing_status:same.status};
 let similar:any[]=[];
 try {
   similar=(await S.search(title,{limit:7})).filter(x=>x.title.toLowerCase().includes(title.toLowerCase())||title.toLowerCase().includes(x.title.toLowerCase())).map(x=>({path:x.path,title:x.title}));
 }catch { /* index optional */ }
 const id='conv-'+randomUUID();
 const candidate:Candidate={id,kind:input.kind,project,title,content,evidence,conversation_ref:input.conversation_ref,status:'pending',created_at:now()};
 writeJson(location(id),candidate);
 return {status:'pending_review',id,possible_duplicates:similar,source_count:evidence.length};
}
export function review(id:string,decision:'approve'|'reject') {
 const c=getCandidate(id);
 if(!c) throw new Error('후보 없음');
 if(c.status!=='pending') return {id,status:c.status,note_path:c.note_path};
 if(decision==='reject') {c.status='rejected';c.reviewed_at=now();writeJson(location(id),c);return {id,status:c.status};}
 const dir=path.join(config.knowledgeDir,'notes','conversations');
 ensureDir(dir);
 const filename=slugify(c.title,90)+'-'+c.id.slice(-8)+'.md';
 const target=path.join(dir,filename);
 if(fs.existsSync(target)) throw new Error('경로 중복');
 const body=['# '+c.title,'','## 지식',c.content,'','## 근거',...(c.evidence.length?c.evidence.map(e=>'- '+e):['- 직접 제공된 외부 근거 없음; 대화 중 정리된 판단/경험']),'','## 추적','- 후보 ID: '+c.id,'- 프로젝트: '+c.project,'- 원 대화 참조: '+(c.conversation_ref||'미제공')].join('\n');
 writeFile(target,stringifyDoc({type:'conversation',title:c.title,project:c.project,kind:c.kind,created:c.created_at,approved:now(),candidate_id:c.id,conversation_ref:c.conversation_ref||undefined,evidence:c.evidence},body));
 c.status='approved';c.reviewed_at=now();c.note_path=path.relative(config.knowledgeDir,target);writeJson(location(id),c);
 return {id,status:c.status,note_path:c.note_path,index_refresh_required:true};
}
