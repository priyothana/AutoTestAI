"use client"
import{useState,useRef,useEffect}from"react"
import{Sparkles,X,Loader2,Check,ChevronRight,Layers,Send,ArrowLeft,CheckSquare,Square,GitBranch,Cpu,Zap,RefreshCw,ChevronDown,ChevronUp,GripVertical}from"lucide-react"
import{Button}from"@/components/ui/button"
import{Badge}from"@/components/ui/badge"
import{toast}from"sonner"
import{Sheet,SheetContent,SheetHeader,SheetTitle,SheetDescription}from"@/components/ui/sheet"
const API=(process.env.NEXT_PUBLIC_API_URL||"http://localhost:4000")+"/api/v1"

// Types
type Phase="flow"|"generating"|"review"|"done"
interface Msg{role:"user"|"assistant";content:string}
interface TC{id:string;name:string;priority:string;description?:string|null;steps?:unknown[]}
interface FlowItem{name:string;description:string}
interface FlowGroup{flow:string;order:number;rationale:string;testCases:(TC&{id?:string})[]}
interface Props{open:boolean;onClose:()=>void;onGenerationComplete:(ids:string[])=>void}

// ── Priority badge ────────────────────────────────────────────────────────────
function PriBadge({p}:{p:string}){
  const map:Record<string,string>={
    high:"bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800",
    medium:"bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800",
    low:"bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800",
  }
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold capitalize ${map[p?.toLowerCase()]??"bg-slate-100 text-slate-600"}`}>{p}</span>
}

// ── AI chat bubble ────────────────────────────────────────────────────────────
function AiBubble({content,loading}:{content?:string;loading?:boolean}){
  return(
    <div className="flex gap-2.5 items-start">
      <div className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
        <Cpu className="h-3.5 w-3.5 text-white"/>
      </div>
      <div className="max-w-[88%] px-3 py-2.5 rounded-xl rounded-tl-none text-[12px] leading-relaxed bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300">
        {loading
          ?<span className="flex gap-1 items-center"><span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{animationDelay:"0ms"}}/><span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{animationDelay:"150ms"}}/><span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{animationDelay:"300ms"}}/></span>
          :content}
      </div>
    </div>
  )
}

function UserBubble({content}:{content:string}){
  return(
    <div className="flex justify-end">
      <div className="max-w-[85%] px-3 py-2.5 rounded-xl rounded-tr-none text-[12px] leading-relaxed text-white" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
        {content}
      </div>
    </div>
  )
}

// ── Step indicator ────────────────────────────────────────────────────────────
function StepBar({phase}:{phase:Phase}){
  const steps=[{id:"flow",label:"Select Flows"},{id:"generating",label:"Generating"},{id:"review",label:"Review"},{id:"done",label:"Done"}]
  const idx=steps.findIndex(s=>s.id===phase)
  return(
    <div className="flex items-center gap-0 px-6 py-3 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-black/10">
      {steps.map((s,i)=>(
        <div key={s.id} className="flex items-center gap-0 flex-1">
          <div className={`flex items-center gap-1.5 ${i<=idx?"text-violet-600 dark:text-violet-400":"text-slate-400"}`}>
            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${i<idx?"bg-violet-600 text-white":i===idx?"bg-violet-600 text-white ring-2 ring-violet-200 dark:ring-violet-800":"bg-slate-200 dark:bg-slate-700 text-slate-400"}`}>
              {i<idx?<Check className="h-3 w-3"/>:i+1}
            </div>
            <span className="text-[10px] font-semibold uppercase tracking-wide hidden sm:block">{s.label}</span>
          </div>
          {i<steps.length-1&&<div className={`flex-1 h-px mx-2 ${i<idx?"bg-violet-400":"bg-slate-200 dark:bg-slate-700"}`}/>}
        </div>
      ))}
    </div>
  )
}

// ── Collapsible FlowGroup card for Review phase ───────────────────────────────
function FlowGroupCard({
  group,selectedIds,onToggleTc,onToggleAll,
}:{
  group:FlowGroup
  selectedIds:Set<string>
  onToggleTc:(id:string)=>void
  onToggleAll:(ids:string[],val:boolean)=>void
}){
  const [open,setOpen]=useState(true)
  const ids=group.testCases.map(t=>t.id).filter(Boolean) as string[]
  const selCount=ids.filter(id=>selectedIds.has(id)).length
  const allSel=ids.length>0&&selCount===ids.length
  return(
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
      <div
        role="button" tabIndex={0}
        onClick={()=>setOpen(v=>!v)}
        onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setOpen(v=>!v)}}}
        className="w-full flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-violet-50 to-indigo-50/60 dark:from-violet-950/30 dark:to-indigo-950/20 hover:from-violet-100 dark:hover:from-violet-950/50 transition-colors text-left cursor-pointer select-none">
        <div className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-black text-white flex-shrink-0"
          style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
          {group.order}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">{group.flow}</span>
            <Badge variant="outline" className="text-[10px] border-violet-300 text-violet-600 dark:border-violet-700 dark:text-violet-400 hidden sm:inline-flex">
              {selCount}/{ids.length} selected
            </Badge>
          </div>
          {group.rationale&&<p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{group.rationale}</p>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={e=>{e.stopPropagation();onToggleAll(ids,!allSel)}}
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors ${allSel?"bg-violet-600 text-white":"border border-violet-300 text-violet-600 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-400"}`}>
            {allSel?"Deselect all":"Select all"}
          </button>
          {open?<ChevronUp className="h-4 w-4 text-slate-400"/>:<ChevronDown className="h-4 w-4 text-slate-400"/>}
        </div>
      </div>
      {open&&(
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {group.testCases.map((tc,i)=>{
            const sel=tc.id?selectedIds.has(tc.id):false
            return(
              <div key={tc.id??i} onClick={()=>tc.id&&onToggleTc(tc.id)}
                className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors ${sel?"bg-violet-50/50 dark:bg-violet-950/20":"hover:bg-slate-50 dark:hover:bg-slate-900/50"}`}>
                <div className={`mt-0.5 w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border-2 transition-colors ${sel?"bg-violet-600 border-violet-600":"border-slate-300 dark:border-slate-600"}`}>
                  {sel&&<Check className="h-2.5 w-2.5 text-white"/>}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-[12px] font-medium leading-snug ${sel?"text-violet-800 dark:text-violet-200":"text-slate-700 dark:text-slate-300"}`}>{tc.name}</p>
                  {tc.description&&<p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">{tc.description}</p>}
                  {tc.steps&&<p className="text-[10px] text-slate-400 mt-0.5">{(tc.steps as any[]).length} steps</p>}
                </div>
                <PriBadge p={tc.priority}/>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function AIGenerateDrawer({open,onClose,onGenerationComplete}:Props){
  // Core state
  const [phase,setPhase]=useState<Phase>("flow")
  const [projectId,setProjectId]=useState("")
  const [projects,setProjects]=useState<{id:string;name:string}[]>([])
  const [projLoading,setProjLoading]=useState(false)

  // Phase 1 — multi-select flows
  const [flows,setFlows]=useState<FlowItem[]>([])
  const [flowsLoading,setFlowsLoading]=useState(false)
  const [selectedFlows,setSelectedFlows]=useState<Set<string>>(new Set())
  const [customFlowInput,setCustomFlowInput]=useState("")

  // Phase 2 — generating progress
  const [genProgress,setGenProgress]=useState(0)
  const [genMessage,setGenMessage]=useState("Initialising…")

  // Phase 3 — review
  const [groups,setGroups]=useState<FlowGroup[]>([])
  const [selectedIds,setSelectedIds]=useState<Set<string>>(new Set())
  const [filterHistory,setFilterHistory]=useState<Msg[]>([])
  const [filterInput,setFilterInput]=useState("")
  const [filterSending,setFilterSending]=useState(false)
  const [approving,setApproving]=useState(false)

  const filterEndRef=useRef<HTMLDivElement>(null)
  const filterInputRef=useRef<HTMLInputElement>(null)

  useEffect(()=>{filterEndRef.current?.scrollIntoView({behavior:"smooth"})},[filterHistory,filterSending])
  useEffect(()=>{if(phase==="review")setTimeout(()=>filterInputRef.current?.focus(),100)},[phase])

  // ── Load projects ──────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!open)return
    setProjLoading(true)
    fetch(`${API}/projects`).then(r=>r.ok?r.json():Promise.reject()).then(d=>{
      const list=Array.isArray(d)?d:d.items??[]
      setProjects(list.map((p:any)=>({id:p.id,name:p.name})))
      if(list.length===1&&!projectId)setProjectId(list[0].id)
    }).catch(()=>{}).finally(()=>setProjLoading(false))
  },[open])

  // Reset on close
  const handleClose=()=>{
    setPhase("flow");setFlows([]);setSelectedFlows(new Set());setCustomFlowInput("")
    setGroups([]);setSelectedIds(new Set());setFilterHistory([]);setFilterInput("")
    setApproving(false)
    onClose()
  }

  // ── Phase 1: Discover flows ────────────────────────────────────────────────
  const loadFlows=async()=>{
    if(!projectId){toast.error("Select a project first");return}
    setFlowsLoading(true);setFlows([]);setSelectedFlows(new Set())
    try{
      const res=await fetch(`${API}/projects/${projectId}/generate-workflows`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})})
      if(!res.ok)throw new Error("Failed")
      const d=await res.json()
      const raw:unknown[]=Array.isArray(d.flows)?d.flows:[]
      const items:FlowItem[]=raw.map((f:any)=>
        typeof f==="string"?{name:f,description:""}:{name:f.name??f,description:f.description??""}
      )
      setFlows(items)
    }catch{toast.error("Could not discover flows")}
    finally{setFlowsLoading(false)}
  }

  const toggleFlow=(name:string)=>setSelectedFlows(prev=>{
    const n=new Set(prev);n.has(name)?n.delete(name):n.add(name);return n
  })

  const addCustomFlow=()=>{
    const name=customFlowInput.trim()
    if(!name)return
    if(flows.some(f=>f.name.toLowerCase()===name.toLowerCase())){
      setSelectedFlows(prev=>{const n=new Set(prev);n.add(name);return n})
      setCustomFlowInput("");return
    }
    setFlows(prev=>[...prev,{name,description:"Custom workflow defined by you."}])
    setSelectedFlows(prev=>{const n=new Set(prev);n.add(name);return n})
    setCustomFlowInput("")
    toast.success(`Custom flow "${name}" added`)
  }

  // ── Phase 2: Generate test suite for all selected flows ───────────────────
  const handleGenerate=async()=>{
    if(selectedFlows.size===0){toast.error("Select at least one flow");return}
    setPhase("generating");setGenProgress(0);setGenMessage("Ordering flows for optimal execution…")
    try{
      const progressSteps=[
        [800,20,"Ordering flows for optimal execution…"],
        [1600,40,"Generating test cases per flow…"],
        [2400,65,"Grounding test steps in project metadata…"],
        [1200,80,"Persisting test cases…"],
      ]
      let delay=0
      for(const[ms,pct,msg]of progressSteps){
        delay+=ms as number
        setTimeout(()=>{setGenProgress(pct as number);setGenMessage(msg as string)},delay)
      }

      const res=await fetch(`${API}/projects/${projectId}/generate-test-suite`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({flows:Array.from(selectedFlows)})
      })
      if(!res.ok)throw new Error("Generation failed")
      const d:{groups:FlowGroup[];totalTestCases:number}=await res.json()

      setGroups(d.groups)
      const allIds=new Set(d.groups.flatMap(g=>g.testCases.map(tc=>tc.id).filter(Boolean) as string[]))
      setSelectedIds(allIds)
      setGenProgress(100);setGenMessage("Done!")
      setTimeout(()=>setPhase("review"),600)
      toast.success(`Generated ${d.totalTestCases} test cases across ${d.groups.length} flows!`)
    }catch(e:any){
      toast.error(e?.message??"Generation failed");setPhase("flow")
    }
  }

  // ── Phase 3: Filter chat ───────────────────────────────────────────────────
  const allTcs=groups.flatMap(g=>g.testCases)

  const sendFilter=async(msg:string)=>{
    const text=msg.trim();if(!text||filterSending)return
    setFilterInput("");setFilterSending(true)
    setFilterHistory(prev=>[...prev,{role:"user",content:text}])
    try{
      const res=await fetch(`${API}/projects/${projectId}/filter-test-cases-chat`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          instruction:text,history:filterHistory.slice(-8),
          testCases:allTcs.map(tc=>({id:tc.id,name:tc.name,priority:tc.priority,description:tc.description})),
          currentSelectedIds:Array.from(selectedIds),
        })
      })
      if(!res.ok)throw new Error()
      const d=await res.json()
      setFilterHistory(prev=>[...prev,{role:"assistant",content:d.reply}])
      if(Array.isArray(d.selectedIds))setSelectedIds(new Set(d.selectedIds))
    }catch{setFilterHistory(prev=>[...prev,{role:"assistant",content:"Sorry, I couldn't process that."}])}
    finally{setFilterSending(false)}
  }

  const toggleTc=(id:string)=>setSelectedIds(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n})
  const toggleGroupAll=(ids:string[],val:boolean)=>setSelectedIds(prev=>{
    const n=new Set(prev);ids.forEach(id=>val?n.add(id):n.delete(id));return n
  })

  // ── Approve & generate steps ───────────────────────────────────────────────
  const handleApprove=async()=>{
    if(selectedIds.size===0){toast.error("Select at least one test case");return}
    setApproving(true)
    try{
      // Delete unselected test cases
      const allIds=groups.flatMap(g=>g.testCases.map(t=>t.id).filter(Boolean)) as string[]
      const toDel=allIds.filter(id=>!selectedIds.has(id))
      if(toDel.length>0){
        await fetch(`${API}/tests/bulk-delete`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids:toDel})})
      }
      // Generate Playwright steps for selected
      toast.info(`Generating Playwright steps for ${selectedIds.size} test cases…`)
      const sr=await fetch(`${API}/projects/${projectId}/generate-steps-for-selected`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({testCaseIds:Array.from(selectedIds)})
      })
      const sData=sr.ok?await sr.json():null
      if(sData?.generated)toast.success(`✅ ${sData.generated} test cases ready with Playwright steps`)
      else toast.success(`✅ ${selectedIds.size} test cases added to Tests!`)
      setPhase("done")
      onGenerationComplete(Array.from(selectedIds))
    }catch{toast.error("Failed to add test cases")}
    finally{setApproving(false)}
  }

  // ── RENDER ─────────────────────────────────────────────────────────────────
  return(
    <Sheet open={open} onOpenChange={v=>{if(!v)handleClose()}}>
      <SheetContent side="right" className="w-full sm:w-[580px] sm:max-w-[580px] p-0 flex flex-col overflow-hidden">
        <SheetHeader className="sr-only"><SheetTitle>AI Test Generator</SheetTitle></SheetHeader>

        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b border-slate-200 dark:border-slate-800" style={{background:"linear-gradient(135deg,#2e1065 0%,#1e1b4b 50%,#0f172a 100%)"}}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
                <Sparkles className="h-4 w-4 text-white"/>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-black tracking-[0.15em] text-white uppercase">AI Test Generator</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/30 text-violet-200 font-semibold border border-violet-500/40">BETA</span>
                </div>
                <p className="text-[11px] text-violet-300 mt-0.5">Multi-Flow Test Suite Wizard</p>
              </div>
            </div>
            <button onClick={handleClose} className="p-1.5 rounded-md text-violet-300 hover:text-white hover:bg-white/10 transition-colors"><X className="h-4 w-4"/></button>
          </div>
        </div>

        <StepBar phase={phase}/>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">

          {/* ── PHASE 1: Flow Selection (multi-select) ── */}
          {phase==="flow"&&(
            <div className="p-6 space-y-5">
              <div>
                <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-2"><GitBranch className="h-4 w-4 text-violet-500"/>Select Business Flows</h3>
                <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-1">Choose a project, discover all end-to-end journeys, then pick the ones you want to test. You can select multiple flows.</p>
              </div>

              {/* Project selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide">Project</label>
                {projLoading
                  ?<div className="flex items-center gap-2 text-sm text-slate-400 py-2"><Loader2 className="h-4 w-4 animate-spin"/>Loading projects…</div>
                  :<select value={projectId} onChange={e=>{setProjectId(e.target.value);setFlows([]);setSelectedFlows(new Set())}}
                      className="w-full px-3 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent transition-all">
                      <option value="">— Choose a project —</option>
                      {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>}
              </div>

              {/* Discover flows button */}
              {projectId&&(
                <Button onClick={loadFlows} disabled={flowsLoading} variant="outline" className="w-full border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/30 gap-2">
                  {flowsLoading?<><Loader2 className="h-4 w-4 animate-spin"/>Discovering flows…</>:<><Zap className="h-4 w-4"/>Discover Business Flows</>}
                </Button>
              )}

              {/* Multi-select flow cards */}
              {flows.length>0&&(
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                      {flows.length} flows discovered — select flows to test
                    </p>
                    <button
                      onClick={()=>setSelectedFlows(selectedFlows.size===flows.length?new Set():new Set(flows.map(f=>f.name)))}
                      className="text-[11px] font-semibold text-violet-600 dark:text-violet-400 hover:underline">
                      {selectedFlows.size===flows.length?"Deselect all":"Select all"}
                    </button>
                  </div>

                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {flows.map((f,i)=>{
                      const sel=selectedFlows.has(f.name)
                      return(
                        <button key={i} onClick={()=>toggleFlow(f.name)} type="button"
                          className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all duration-150 flex items-start gap-3 ${sel
                            ?"border-violet-500 bg-violet-50 dark:bg-violet-950/40 shadow-sm shadow-violet-100 dark:shadow-violet-900/20"
                            :"border-slate-200 dark:border-slate-700 hover:border-violet-300 dark:hover:border-violet-600 hover:bg-violet-50/30 dark:hover:bg-violet-950/10"}`}>
                          <div className={`mt-0.5 w-5 h-5 rounded flex-shrink-0 flex items-center justify-center border-2 transition-colors ${sel?"bg-violet-600 border-violet-600":"border-slate-300 dark:border-slate-600"}`}>
                            {sel&&<Check className="h-3 w-3 text-white"/>}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm font-semibold leading-snug ${sel?"text-violet-800 dark:text-violet-200":"text-slate-700 dark:text-slate-300"}`}>{f.name}</p>
                            {f.description&&<p className={`text-[11px] leading-relaxed mt-0.5 ${sel?"text-violet-700/80 dark:text-violet-300/80":"text-slate-400 dark:text-slate-500"}`}>{f.description}</p>}
                          </div>
                          <GitBranch className={`h-4 w-4 flex-shrink-0 mt-0.5 ${sel?"text-violet-500":"text-slate-300 dark:text-slate-600"}`}/>
                        </button>
                      )
                    })}
                  </div>

                  {/* Custom flow input */}
                  <div className="rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 p-4 space-y-3">
                    <p className="text-xs font-bold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                      <Zap className="h-3.5 w-3.5 text-violet-500"/>Add a custom business flow
                    </p>
                    <div className="flex gap-2">
                      <input
                        value={customFlowInput}
                        onChange={e=>setCustomFlowInput(e.target.value)}
                        onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();addCustomFlow()}}}
                        placeholder='e.g. "Generate Invoice and Send to Customer"'
                        className="flex-1 px-3 py-2.5 rounded-lg text-[12px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-violet-400 text-slate-800 dark:text-slate-200 placeholder-slate-400"
                      />
                      <Button type="button" onClick={addCustomFlow} disabled={!customFlowInput.trim()} variant="outline"
                        className="flex-shrink-0 gap-1.5 border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/30 font-semibold text-[12px]">
                        <Check className="h-3.5 w-3.5"/>Add
                      </Button>
                    </div>
                  </div>

                  {/* Selected flows summary */}
                  {selectedFlows.size>0&&(
                    <div className="flex flex-wrap gap-1.5">
                      {Array.from(selectedFlows).map(name=>(
                        <span key={name} className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-700">
                          {name}
                          <button onClick={()=>toggleFlow(name)} className="hover:text-violet-900 dark:hover:text-violet-100 ml-0.5">
                            <X className="h-2.5 w-2.5"/>
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* CTA */}
              {selectedFlows.size>0&&(
                <Button onClick={handleGenerate} className="w-full gap-2 text-white shadow-lg h-12 text-sm font-bold" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
                  <Sparkles className="h-4 w-4"/>
                  Generate Test Suite for {selectedFlows.size} flow{selectedFlows.size!==1?"s":""}
                  <ChevronRight className="h-4 w-4"/>
                </Button>
              )}
            </div>
          )}

          {/* ── PHASE 2: Generating ── */}
          {phase==="generating"&&(
            <div className="flex flex-col items-center gap-8 py-20 px-8">
              <div className="relative">
                <div className="absolute inset-0 rounded-full animate-ping opacity-15" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}/>
                <div className="relative w-20 h-20 rounded-full flex items-center justify-center" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
                  <Loader2 className="h-9 w-9 text-white animate-spin"/>
                </div>
              </div>
              <div className="text-center space-y-2">
                <p className="text-xl font-black text-slate-800 dark:text-slate-100">Generating your test suite…</p>
                <p className="text-sm text-slate-500 dark:text-slate-400 max-w-sm">{genMessage}</p>
              </div>
              <div className="w-full space-y-2">
                <div className="flex justify-between text-[11px] text-slate-500">
                  <span>Progress</span><span>{genProgress}%</span>
                </div>
                <div className="h-2.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-700" style={{width:`${genProgress}%`,background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}/>
                </div>
                <div className="flex flex-wrap gap-1.5 justify-center mt-2">
                  {Array.from(selectedFlows).map(name=>(
                    <span key={name} className="text-[10px] px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-300 border border-violet-200 dark:border-violet-700">{name}</span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── PHASE 3: Review & Filter ── */}
          {phase==="review"&&(
            <div className="flex flex-col h-full min-h-0">
              {/* Summary bar */}
              <div className="flex-shrink-0 px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-sm font-bold text-slate-800 dark:text-slate-100">Review & Filter Test Cases</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {groups.reduce((s,g)=>s+g.testCases.length,0)} test cases across {groups.length} flows
                  </p>
                </div>
                <Badge variant="outline" className="border-violet-300 text-violet-600 bg-violet-50 dark:bg-violet-950/30 dark:border-violet-700 dark:text-violet-300">
                  {selectedIds.size} selected
                </Badge>
              </div>

              {/* Flow groups */}
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0">
                {groups.map((group,gi)=>(
                  <FlowGroupCard key={gi} group={group} selectedIds={selectedIds} onToggleTc={toggleTc} onToggleAll={toggleGroupAll}/>
                ))}

                {/* AI Filter Chat */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 bg-gradient-to-r from-violet-50 to-indigo-50/60 dark:from-violet-950/30 dark:to-indigo-950/20 flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-violet-500"/>
                    <span className="text-xs font-bold text-slate-700 dark:text-slate-200">AI Filter Assistant</span>
                  </div>
                  <div className="max-h-40 overflow-y-auto px-4 py-3 space-y-3">
                    {filterHistory.length===0&&(
                      <p className="text-[11px] text-slate-400 text-center py-2">
                        Tell me what to keep or remove, e.g. <span className="italic">"Keep only High priority"</span>
                      </p>
                    )}
                    {filterHistory.map((m,i)=>(
                      <div key={i}>{m.role==="assistant"?<AiBubble content={m.content}/>:<UserBubble content={m.content}/>}</div>
                    ))}
                    {filterSending&&<AiBubble loading/>}
                    <div ref={filterEndRef}/>
                  </div>
                  <div className="flex-shrink-0 px-3 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-black/10 flex gap-2">
                    <input ref={filterInputRef} value={filterInput} onChange={e=>setFilterInput(e.target.value)}
                      onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendFilter(filterInput)}}}
                      disabled={filterSending} placeholder='e.g. "Remove Low priority tests"'
                      className="flex-1 px-3 py-2 rounded-lg text-[12px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-violet-400 text-slate-800 dark:text-slate-200 placeholder-slate-400"/>
                    <Button size="icon" className="h-9 w-9 flex-shrink-0 rounded-lg text-white"
                      style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}
                      onClick={()=>sendFilter(filterInput)} disabled={!filterInput.trim()||filterSending}>
                      {filterSending?<Loader2 className="h-3.5 w-3.5 animate-spin"/>:<Send className="h-3.5 w-3.5"/>}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Approve footer */}
              <div className="flex-shrink-0 px-4 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
                <Button onClick={handleApprove} disabled={selectedIds.size===0||approving}
                  className="w-full gap-2 text-white h-11 text-sm font-bold shadow-lg" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
                  {approving?<><Loader2 className="h-4 w-4 animate-spin"/>Generating steps…</>
                    :<><Sparkles className="h-4 w-4"/>Approve & Add {selectedIds.size} Test Case{selectedIds.size!==1?"s":""}</>}
                </Button>
                <p className="text-[10px] text-center text-slate-400 mt-1.5">Selected test cases will get Playwright steps generated automatically.</p>
              </div>
            </div>
          )}

          {/* ── PHASE 4: Done ── */}
          {phase==="done"&&(
            <div className="flex flex-col items-center justify-center flex-1 p-8 gap-6 text-center min-h-[400px]">
              <div className="relative">
                <div className="absolute inset-0 rounded-full bg-emerald-400/20 blur-2xl scale-150 animate-pulse"/>
                <div className="relative w-20 h-20 rounded-full flex items-center justify-center shadow-xl" style={{background:"linear-gradient(135deg,#10b981,#059669)"}}>
                  <Check className="h-10 w-10 text-white"/>
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-xl font-bold text-slate-800 dark:text-slate-100">Test Suite Created!</p>
                <p className="text-sm text-slate-500 dark:text-slate-400 max-w-xs">
                  Your AI-generated test cases are live in the Tests tab with full Playwright steps ready to run.
                </p>
              </div>
              <div className="flex flex-col gap-2.5 w-full max-w-xs">
                <Button onClick={handleClose} className="w-full gap-2 text-white shadow-lg" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
                  <Check className="h-4 w-4"/>Go to Tests
                </Button>
                <Button variant="outline" onClick={()=>{
                  setPhase("flow");setFlows([]);setSelectedFlows(new Set());setCustomFlowInput("")
                  setGroups([]);setSelectedIds(new Set());setFilterHistory([])
                }} className="w-full gap-2 border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/30">
                  <Sparkles className="h-4 w-4"/>Generate Another Suite
                </Button>
              </div>
            </div>
          )}

        </div>{/* end scrollable body */}
      </SheetContent>
    </Sheet>
  )
}
