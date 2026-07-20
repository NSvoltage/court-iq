/* Minimal .xlsx reader: fflate.unzipSync + regex XML parse. Browser+Node.
   Returns { SheetName: [[cell,...],...] }. CSP-safe (no eval, no CDN). */
(function(root){
  "use strict";
  const fflate = root.fflate || (typeof require!=="undefined" ? require("./fflate.js") : null);
  function unescapeXml(s){return s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(m,d)=>String.fromCharCode(+d)).replace(/&#x([0-9a-fA-F]+);/g,(m,h)=>String.fromCharCode(parseInt(h,16))).replace(/&amp;/g,"&");}
  function colToIdx(ref){ // "B12" -> 1
    const m=/^([A-Z]+)/.exec(ref); let n=0; for(const ch of m[1]) n=n*26+(ch.charCodeAt(0)-64); return n-1;
  }
  function textDecode(u8){ return new TextDecoder("utf-8").decode(u8); }
  function parseSharedStrings(xml){
    if(!xml) return [];
    const out=[]; const re=/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g; let m;
    while((m=re.exec(xml))){
      if(m[1]===undefined){ out.push(""); continue; } // self-closing <si/> = empty string (must still occupy an index)
      const si=m[1]; let text="";
      const tre=/<t\b[^>]*>([\s\S]*?)<\/t>/g; let t;
      while((t=tre.exec(si))) text+=t[1];
      out.push(unescapeXml(text));
    }
    return out;
  }
  function parseSheet(xml, shared){
    const rows=[]; const rowRe=/<row\b[^>]*>([\s\S]*?)<\/row>/g; let rm;
    while((rm=rowRe.exec(xml))){
      const cells=[]; const inner=rm[1];
      const cRe=/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
      let maxc=-1; const buf=[];
      while((cm=cRe.exec(inner))){
        const attr=cm[1], body=cm[2]||"";
        const refm=/r="([A-Z]+\d+)"/.exec(attr); const ci=refm?colToIdx(refm[1]):buf.length;
        const tm=/t="([^"]+)"/.exec(attr); const type=tm?tm[1]:"n";
        let val=null;
        if(type==="s"){ const vm=/<v>([\s\S]*?)<\/v>/.exec(body); if(vm) val=shared[+vm[1]]; }
        else if(type==="inlineStr"){ const im=/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body); if(im) val=unescapeXml(im[1]); }
        else if(type==="str"){ const vm=/<v>([\s\S]*?)<\/v>/.exec(body); if(vm) val=unescapeXml(vm[1]); }
        else { const vm=/<v>([\s\S]*?)<\/v>/.exec(body); if(vm){ const n=Number(vm[1]); val=isFinite(n)?n:vm[1]; } }
        buf[ci]=val; if(ci>maxc)maxc=ci;
      }
      for(let i=0;i<=maxc;i++) cells.push(buf[i]===undefined?null:buf[i]);
      rows.push(cells);
    }
    return rows;
  }
  function parse(arrayBuffer){
    const u8=new Uint8Array(arrayBuffer);
    const files=fflate.unzipSync(u8);
    const dec={}; for(const k in files) dec[k]=files[k];
    const shared=parseSharedStrings(files["xl/sharedStrings.xml"]?textDecode(files["xl/sharedStrings.xml"]):"");
    // map sheet name -> target file
    const wb=textDecode(files["xl/workbook.xml"]);
    const rels=files["xl/_rels/workbook.xml.rels"]?textDecode(files["xl/_rels/workbook.xml.rels"]):"";
    const relMap={}; let r; const relRe=/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
    while((r=relRe.exec(rels))) relMap[r[1]]=r[2].replace(/^\/?xl\//,"").replace(/^\//,"");
    const out={}; const shRe=/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g; let sm; let order=[];
    while((sm=shRe.exec(wb))){ order.push([unescapeXml(sm[1]), sm[2]]); }
    order.forEach(([name,rid],i)=>{
      let target=relMap[rid];
      let path = target ? ("xl/"+target.replace(/^xl\//,"")) : ("xl/worksheets/sheet"+(i+1)+".xml");
      if(!files[path]) path="xl/worksheets/sheet"+(i+1)+".xml";
      const xml=files[path]?textDecode(files[path]):"";
      out[name]=xml?parseSheet(xml,shared):[];
    });
    return out;
  }
  root.xlsxlite={parse};
})(typeof window!=="undefined"?window:globalThis);
