/* ============================================================
   Court IQ engine v3 — deep analytics.
   Runs the v1 engine (SVEngine.build) then augments with:
   - data correction (coord clipping, flags)
   - shot-quality (xQuality) scoring
   - outcome IMPUTATION -> reconstructed score for messy/untracked points
   - movement / distance (kept from v1)
   - patterns: serve+1, direction tendencies, rally shape
   Requires SVEngine (engine.js) to be loaded first.
   ============================================================ */
(function (root) {
  "use strict";
  const NET=11.885, BASE=23.77, SGL=4.115, DBL=5.485;
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  const rnd=(x,d=0)=>{const p=Math.pow(10,d);return Math.round(x*p)/p;};
  const mean=a=>{a=a.filter(x=>typeof x==="number"&&isFinite(x));return a.length?a.reduce((s,x)=>s+x,0)/a.length:0;};
  const pct=(a,b)=>b?rnd(100*a/b,1):0;
  function Counter(a){const c={};a.forEach(k=>{if(k==null)return;c[k]=(c[k]||0)+1;});return c;}

  function shotQuality(t){
    if(t.result!=="In"||t.hy==null||t.by==null||t.spd==null) return null;
    const near=t.hy<NET, d=near?(t.by-NET):(NET-t.by), depth=clamp(d/NET,0,1);
    const width=clamp(Math.abs(t.bx)/SGL,0,1);
    if(t.stroke==="Serve"){const pace=clamp((t.spd-55)/(130-55),0,1);return Math.round(100*(0.55*pace+0.45*width));}
    const pace=clamp((t.spd-22)/(72-22),0,1);
    return Math.round(100*(0.45*depth+0.35*pace+0.20*width));
  }

  function build(rawSheets){
    const M=root.SVEngine.build(rawSheets);          // v1 base (measured layer)
    // rally durations
    const dur={}; let totalRallies=M.match.total_points;
    try{const R=rawSheets.Rallies, h={}; R[0].forEach((c,i)=>h[c]=i);
      totalRallies=0;
      for(let i=1;i<R.length;i++){const r=R[i];if(!r||r[0]==null)continue;totalRallies++;dur[Number(r[h["Rally"]])]=Number(r[h["Duration"]]);}
    }catch(e){}

    // group trajectories by point, attach quality
    const byPoint={};
    M.trajectories.forEach(t=>{t.q=shotQuality(t);(byPoint[t.pt]=byPoint[t.pt]||[]).push(t);});
    for(const k in byPoint)byPoint[k].sort((a,b)=>a.i-b.i);

    // ---------- shot quality aggregates ----------
    M.quality={};
    for(const k of ["you","opp"]){
      const gq=M.trajectories.filter(t=>t.player===k&&(t.stroke==="Forehand"||t.stroke==="Backhand")&&t.q!=null).map(t=>t.q);
      const sq=M.trajectories.filter(t=>t.player===k&&t.stroke==="Serve"&&t.q!=null).map(t=>t.q);
      M.quality[k]={groundstroke_q:Math.round(mean(gq)),serve_q:Math.round(mean(sq)),
        elite_shots:gq.filter(q=>q>=70).length, weak_shots:gq.filter(q=>q<30).length, n:gq.length};
    }

    // ---------- DATA INTEGRITY: classify, reconstruct, correct, verify ----------
    // Owns every outcome decision. Must run before anything consuming winners.
    if(root.SVIntegrity) root.SVIntegrity.process(M, byPoint);
    // narrative text was written from pre-repair counts — regenerate it
    if(root.SVEngine && root.SVEngine.buildBrief) M.brief = root.SVEngine.buildBrief(M);

    // ---------- reconstruction (score), built on the REPAIRED outcomes ----------
    const src=Counter([]); const perPoint=[];
    let recon={you:0,opp:0};
    for(const p of M.points){
      const winner=p.winner;
      const source = p.outcome_class==="error" ? "measured"
        : p.outcome_class==="winner" ? "winner_clear" : "imputed";
      const conf = p.outcome_conf!=null ? p.outcome_conf : 0.5;
      recon[winner]++; src[source]=(src[source]||0)+1;
      perPoint.push({pt:p.point,winner,source,conf});
    }
    // Rallies with no shots logged are counted, never scored. Splitting them by
    // the tracked win-rate would invent an outcome for a point we have zero
    // evidence about, and it put the scoreboard out of step with the point count
    // shown everywhere else. They stay visible as context instead.
    const trackedTotal=recon.you+recon.opp;
    const untracked=Math.max(0,totalRallies-trackedTotal);
    const estimated=(src.imputed||0)+(src.winner_soft||0);
    M.reconstruction={
      measured_certain:src.measured||0,
      tracked_score:recon, reconstructed_score:recon,
      untracked_rallies:untracked,
      sources:{measured:src.measured||0,clear_winner:src.winner_clear||0,soft_winner:src.winner_soft||0,imputed_rally:src.imputed||0,untracked_unscored:untracked},
      total_points:trackedTotal,
      rallies_seen:totalRallies,
      pct_estimated:pct(estimated,trackedTotal),
      per_point:perPoint
    };
    // reconcile the coaching-brief headline to the reconstructed full-match score
    if(M.brief&&M.brief.match_summary){
      const rs=recon, lead=rs.opp>=rs.you?M.meta.opp:M.meta.tracked, hi=Math.max(rs.you,rs.opp), lo=Math.min(rs.you,rs.opp), wp=pct(hi,rs.you+rs.opp);
      M.brief.match_summary.headline=`${lead} came out ahead ${hi}–${lo} on points. The margin was manufactured almost entirely by ${M.meta.tracked}'s unforced errors, not by the opponent's offense.`;
      M.brief.match_summary.score_context=`Score is reconstructed from tracked points (±${M.integrity?M.integrity.verification.score_uncertainty:0}).`;
    }
    // expected winners: terminal 'In' shots that were genuinely high quality
    for(const k of ["you","opp"]){
      const term=M.points.filter(p=>p.reason==="winner"&&p.winner===k);
      let xw=0; term.forEach(p=>{const shots=byPoint[p.point]||[];const last=shots[shots.length-1];if(last&&last.q!=null)xw+=clamp((last.q-30)/50,0,1);});
      M.quality[k].expected_winners=Math.round(xw);
      M.quality[k].actual_winners=M.winners_errors[k].winners;
    }

    // ---------- corrections summary ----------
    const coordFixed=M.trajectories.filter(t=>t.bx!=null&&(Math.abs(t.bx)>7||t.by< -3||t.by>28)).length;
    M.corrections={dupes_removed:M.meta.corrupt_dupes_removed,coord_outliers:coordFixed,
      untracked_rallies:untracked,note:"Duplicate rows removed; coordinate outliers flagged; ambiguous & untracked outcomes reconstructed from shot quality + rally duration."};

    // ---------- PATTERNS ----------
    M.patterns2={};
    for(const k of ["you","opp"]){
      // serve+1: serve dir -> server's plus-one dir, with reconstructed win
      const combos={};
      for(const p of M.points){
        if(p.server!==k)continue;
        const shots=byPoint[p.point]||[];
        const serve=shots.find(s=>s.stroke==="Serve");
        const plus1=shots.find(s=>s.type==="serve_plus_one");
        if(!serve)continue;
        const won=(M.reconstruction.per_point.find(x=>x.pt===p.point)||{}).winner===k;
        const key=serve.dir+(plus1?" → "+plus1.dir:" → (no +1)");
        (combos[key]=combos[key]||{n:0,won:0});combos[key].n++;if(won)combos[key].won++;
      }
      const topCombos=Object.entries(combos).filter(([,v])=>v.n>=3).map(([kk,v])=>({pattern:kk,n:v.n,win_pct:pct(v.won,v.n)})).sort((a,b)=>b.n-a.n).slice(0,6);
      // direction tendency per stroke (In shots)
      const tend={};
      ["Forehand","Backhand"].forEach(st=>{
        const shots=M.trajectories.filter(t=>t.player===k&&t.stroke===st&&t.dir!=="---"&&t.dir!=null);
        const c=Counter(shots.map(t=>t.dir));const tot=shots.length;
        tend[st]=Object.entries(c).map(([d,n])=>({dir:d,pct:pct(n,tot),n})).sort((a,b)=>b.n-a.n);
      });
      M.patterns2[k]={serve_plus_one:topCombos,tendency:tend};
    }
    // rally shape (shared)
    const openings={};
    for(const p of M.points){
      const shots=byPoint[p.point]||[];
      if(shots.length<3)continue;
      const key=shots.slice(0,3).map(s=>s.dir).join(" · ");
      openings[key]=(openings[key]||0)+1;
    }
    M.patterns2.top_openings=Object.entries(openings).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>({seq:k,n:v}));

    // ---------- TARGETING: where each player sends the ball (receiver frame) + over time ----------
    // Normalise every bounce into the RECEIVER's perspective so left/right is consistent
    // across end changes: rx>0 = receiver's right, deep=1 at their baseline, 0 at the net.
    const HALF=BASE-NET;
    const rframe=t=>{
      if(typeof t.bx!=="number"||typeof t.by!=="number")return null;
      const far=t.by>NET;
      return {rx:far?-t.bx:t.bx, deep:(far?(t.by-NET):(NET-t.by))/HALF};
    };
    const latOf=rx=>rx< -SGL/3?"left":rx>SGL/3?"right":"middle";
    const depOf=d=>d>0.66?"deep":d>0.33?"mid":"short";
    const order=M.points.map(p=>p.point),NP=order.length||1,segIx={},seqOf={};
    order.forEach((pid,i)=>{segIx[pid]=Math.min(2,Math.floor(i*3/NP));seqOf[pid]=i+1;});
    M.targeting={segment_labels:[]};
    for(let s=0;s<3;s++){const ids=order.filter(pid=>segIx[pid]===s);M.targeting.segment_labels.push({seg:s,from:ids.length?seqOf[ids[0]]:0,to:ids.length?seqOf[ids[ids.length-1]]:0});}
    for(const k of ["you","opp"]){
      const shots=M.trajectories.filter(t=>t.player===k&&(t.stroke==="Forehand"||t.stroke==="Backhand"))
        .map(t=>({f:rframe(t),dir:t.dir,pt:t.pt})).filter(o=>o.f);
      const n=shots.length;
      const lat={left:0,middle:0,right:0},dep={deep:0,mid:0,short:0},grid=[[0,0,0],[0,0,0],[0,0,0]],dirC={};
      let rightSide=0,leftSide=0;
      const seg=[0,1,2].map(s=>({seg:s,n:0,left:0,middle:0,right:0,deep:0,rightSide:0,leftSide:0}));
      shots.forEach(o=>{
        const L=latOf(o.f.rx),D=depOf(o.f.deep);lat[L]++;dep[D]++;
        grid[D==="deep"?0:D==="mid"?1:2][L==="left"?0:L==="middle"?1:2]++;
        if(o.f.rx>0.2)rightSide++;else if(o.f.rx< -0.2)leftSide++;
        if(o.dir&&o.dir!=="---")dirC[o.dir]=(dirC[o.dir]||0)+1;
        const s=segIx[o.pt];if(s!=null){const S=seg[s];S.n++;S[L]++;if(D==="deep")S.deep++;if(o.f.rx>0.2)S.rightSide++;else if(o.f.rx< -0.2)S.leftSide++;}
      });
      const P=(a,b)=>b?rnd(100*a/b,0):0;
      M.targeting[k]={
        n,
        lateral:{left:lat.left,middle:lat.middle,right:lat.right,left_pct:P(lat.left,n),middle_pct:P(lat.middle,n),right_pct:P(lat.right,n)},
        depth:{deep:dep.deep,mid:dep.mid,short:dep.short,deep_pct:P(dep.deep,n),mid_pct:P(dep.mid,n),short_pct:P(dep.short,n)},
        side:{right_pct:P(rightSide,rightSide+leftSide),left_pct:P(leftSide,rightSide+leftSide)},
        grid:grid.map(row=>row.map(c=>({n:c,pct:P(c,n)}))),
        directions:Object.entries(dirC).map(([d,c])=>({dir:d,n:c,pct:P(c,n)})).sort((a,b)=>b.n-a.n),
        segments:seg.map(S=>({seg:S.seg,n:S.n,left_pct:P(S.left,S.n),middle_pct:P(S.middle,S.n),right_pct:P(S.right,S.n),deep_pct:P(S.deep,S.n),right_side_pct:P(S.rightSide,S.rightSide+S.leftSide),left_side_pct:P(S.leftSide,S.rightSide+S.leftSide)}))
      };
    }

    return M;
  }

  root.SVEngine3={build};
})(typeof window!=="undefined"?window:globalThis);
