"use client"
import{useState,useRef,useEffect,useCallback}from"react"
import{Sparkles,X,Loader2,Check,ChevronDown,Layers,Send,ArrowLeft,CheckSquare,Square,GitBranch,Cpu,Zap,RefreshCw}from"lucide-react"
import{Button}from"@/components/ui/button"
import{Badge}from"@/components/ui/badge"
import{toast}from"sonner"
import{Sheet,SheetContent,SheetHeader,SheetTitle,SheetDescription}from"@/components/ui/sheet"
const API=(process.env.NEXT_PUBLIC_API_URL||"http://localhost:4000")+"/api/v1"
type Phase="flow"|"refine"|"preview"|"done"
interface Msg{role:"user"|"assistant";content:string}
interface TC{id:string;name:string;priority:string;description?:string|null}
interface Props{open:boolean;onClose:()=>void;onGenerationComplete:(ids:string[])=>void}

// ── Priority badge color ─────────────────────────────────────────────────────
function PriBadge({p}:{p:string}){
  const map:Record<string,string>={
    high:"bg-red-50 text-red-700 border border-red-200",
    medium:"bg-amber-50 text-amber-700 border border-amber-200",
    low:"bg-green-50 text-green-700 border border-green-200",
  }
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${map[p?.toLowerCase()]??""}`}>{p}</span>
}

// ── AI chat bubble ───────────────────────────────────────────────────────────
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

// ── Step indicator ───────────────────────────────────────────────────────────
function StepBar({phase}:{phase:Phase}){
  const steps=[{id:"flow",label:"Select Flow"},{id:"refine",label:"Refine"},{id:"preview",label:"Review"},{id:"done",label:"Done"}]
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

export default function AIGenerateDrawer({open,onClose,onGenerationComplete}:Props){
  // ── Core state ──────────────────────────────────────────────────────────────
  const [phase,setPhase]=useState<Phase>("flow")
  const [projectId,setProjectId]=useState("")
  const [projects,setProjects]=useState<{id:string;name:string}[]>([])
  const [projLoading,setProjLoading]=useState(false)

  // Phase 1 — flow selection
  const [flows,setFlows]=useState<string[]>([])
  const [flowsLoading,setFlowsLoading]=useState(false)
  const [selectedFlow,setSelectedFlow]=useState("")

  // Phase 2 — refinement chat
  const [refineHistory,setRefineHistory]=useState<Msg[]>([])
  const [refineInput,setRefineInput]=useState("")
  const [refineSending,setRefineSending]=useState(false)
  const [readyToGenerate,setReadyToGenerate]=useState(false)
  const [workflowScope,setWorkflowScope]=useState<any>(null)

  // Phase 3 — preview + filter chat
  const [testCases,setTestCases]=useState<TC[]>([])
  const [tcLoading,setTcLoading]=useState(false)
  const [selectedIds,setSelectedIds]=useState<Set<string>>(new Set())
  const [filterHistory,setFilterHistory]=useState<Msg[]>([])
  const [filterInput,setFilterInput]=useState("")
  const [filterSending,setFilterSending]=useState(false)
  const [confirming,setConfirming]=useState(false)
  const [genSteps,setGenSteps]=useState(false)

  const refineEndRef=useRef<HTMLDivElement>(null)
  const filterEndRef=useRef<HTMLDivElement>(null)
  const refineInputRef=useRef<HTMLInputElement>(null)
  const filterInputRef=useRef<HTMLInputElement>(null)

  // Auto-scroll chat panels
  useEffect(()=>{refineEndRef.current?.scrollIntoView({behavior:"smooth"})},[refineHistory,refineSending])
  useEffect(()=>{filterEndRef.current?.scrollIntoView({behavior:"smooth"})},[filterHistory,filterSending])

  // Focus inputs when phase changes
  useEffect(()=>{
    if(phase==="refine")setTimeout(()=>refineInputRef.current?.focus(),100)
    if(phase==="preview")setTimeout(()=>filterInputRef.current?.focus(),100)
  },[phase])

  // ── Load projects ───────────────────────────────────────────────────────────
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
    setPhase("flow");setSelectedFlow("");setFlows([])
    setRefineHistory([]);setRefineInput("");setReadyToGenerate(false);setWorkflowScope(null)
    setTestCases([]);setSelectedIds(new Set());setFilterHistory([]);setFilterInput("")
    setConfirming(false);setGenSteps(false)
    onClose()
  }

  // ── Phase 1: Generate flows ─────────────────────────────────────────────────
  const loadFlows=async()=>{
    if(!projectId){toast.error("Select a project first");return}
    setFlowsLoading(true);setFlows([]);setSelectedFlow("")
    try{
      const res=await fetch(`${API}/projects/${projectId}/generate-workflows`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})})
      if(!res.ok)throw new Error("Failed")
      const d=await res.json()
      setFlows(Array.isArray(d.flows)?d.flows:[])
    }catch{toast.error("Could not generate flows")}
    finally{setFlowsLoading(false)}
  }

  const handleFlowNext=()=>{
    if(!selectedFlow){toast.error("Select a business flow");return}
    setRefineHistory([])
    setReadyToGenerate(false)
    setWorkflowScope(null)
    setPhase("refine")
    // Kick off first AI message — ask a single high-level optional question
    setTimeout(()=>sendRefineMsg("__init__"),100)
  }

  // Skip refinement and jump directly to generation with inferred scope
  const handleSkipToGenerate=async()=>{
    const scopeFromFlow={
      flow:selectedFlow,
      actors:["Application users"],
      preconditions:["User has valid credentials and application is accessible"],
      steps:[`Complete the ${selectedFlow} end-to-end workflow`],
      edgeCases:["Invalid inputs","Session expiry","Concurrent actions"]
    }
    setReadyToGenerate(true)
    setWorkflowScope(scopeFromFlow)
    // Trigger generation immediately
    setTcLoading(true);setPhase("preview");setTestCases([]);setSelectedIds(new Set())
    try{
      const res=await fetch(`${API}/projects/${projectId}/generate-test-cases`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          selectedModule:selectedFlow,
          count:20,
          focusAreas:scopeFromFlow.steps,
        })
      })
      if(!res.ok)throw new Error()
      const d=await res.json()
      const jobId=d.jobId
      let done=false;let attempts=0
      while(!done&&attempts<120){
        await new Promise(r=>setTimeout(r,2500))
        attempts++
        const sr=await fetch(`${API}/projects/${projectId}/generate-test-cases/status/${jobId}`)
        if(sr.ok){
          const sd=await sr.json()
          if(sd.status==="completed"){
            done=true
            if(sd.testCaseIds?.length){
              const br=await fetch(`${API}/tests/bulk-fetch`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids:sd.testCaseIds})})
              if(br.ok){const cases=await br.json();setTestCases(Array.isArray(cases)?cases:[]);setSelectedIds(new Set(cases.map((c:TC)=>c.id)))}
            }
          }else if(sd.status==="failed"){done=true;toast.error("Generation failed")}
        }
      }
      if(!done)toast.error("Generation timed out")
    }catch{toast.error("Failed to generate test cases")}
    finally{setTcLoading(false)}
  }

  // ── Phase 2: Refinement chat ────────────────────────────────────────────────
  const sendRefineMsg=async(msg:string)=>{
    const text=msg.trim();if(!text||refineSending)return
    setRefineInput("")
    setRefineSending(true)
    const userMsg:Msg={role:"user",content:text}
    const isAuto=text==="__init__"
    const nextHistory=isAuto?refineHistory:[...refineHistory,userMsg]
    if(!isAuto)setRefineHistory(nextHistory)
    const msgToSend=isAuto?`Let's define the test scope for the "${selectedFlow}" flow.`:text
    try{
      const res=await fetch(`${API}/projects/${projectId}/workflow-chat`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({flow:selectedFlow,history:nextHistory,userMessage:msgToSend})
      })
      if(!res.ok)throw new Error("Failed")
      const d=await res.json()
      const aMsg:Msg={role:"assistant",content:d.reply}
      setRefineHistory(prev=>[...prev,aMsg])
      if(d.readyToGenerate){
        setReadyToGenerate(true)
        setWorkflowScope(d.workflowScope)
      }
    }catch{setRefineHistory(prev=>[...prev,{role:"assistant",content:"Sorry, something went wrong. Please try again."}])}
    finally{setRefineSending(false)}
  }

  const handleRefineGenerate=async()=>{
    if(!readyToGenerate&&!workflowScope)return
    setTcLoading(true);setPhase("preview");setTestCases([]);setSelectedIds(new Set())
    try{
      const res=await fetch(`${API}/projects/${projectId}/generate-test-cases`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          selectedModule:workflowScope?.flow??selectedFlow,
          count:20,
          focusAreas:workflowScope?.steps??[],
        })
      })
      if(!res.ok)throw new Error()
      const d=await res.json()
      // Poll for completion
      const jobId=d.jobId
      let done=false;let attempts=0
      while(!done&&attempts<120){
        await new Promise(r=>setTimeout(r,2500))
        attempts++
        const sr=await fetch(`${API}/projects/${projectId}/generate-test-cases/status/${jobId}`)
        if(sr.ok){
          const sd=await sr.json()
          if(sd.status==="completed"){
            done=true
            if(sd.testCaseIds?.length){
              const br=await fetch(`${API}/tests/bulk-fetch`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids:sd.testCaseIds})})
              if(br.ok){const cases=await br.json();setTestCases(Array.isArray(cases)?cases:[]);setSelectedIds(new Set(cases.map((c:TC)=>c.id)))}
            }
          }else if(sd.status==="failed"){done=true;toast.error("Generation failed")}
        }
      }
      if(!done)toast.error("Generation timed out")
    }catch{toast.error("Failed to generate test cases")}
    finally{setTcLoading(false)}
  }

  // ── Phase 3: Filter chat ────────────────────────────────────────────────────
  const sendFilterMsg=async(msg:string)=>{
    const text=msg.trim();if(!text||filterSending)return
    setFilterInput("");setFilterSending(true)
    const uMsg:Msg={role:"user",content:text}
    setFilterHistory(prev=>[...prev,uMsg])
    try{
      const res=await fetch(`${API}/projects/${projectId}/filter-test-cases-chat`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          instruction:text,
          history:filterHistory.slice(-8),
          testCases:testCases.map(tc=>({id:tc.id,name:tc.name,priority:tc.priority,description:tc.description})),
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
  const allSel=testCases.length>0&&selectedIds.size===testCases.length
  const toggleAll=()=>setSelectedIds(allSel?new Set():new Set(testCases.map(tc=>tc.id)))

  const handleApprove=async()=>{
    if(selectedIds.size===0){toast.error("Select at least one test case");return}
    setConfirming(true)
    try{
      // Delete unselected
      const toDel=testCases.map(t=>t.id).filter(id=>!selectedIds.has(id))
      if(toDel.length>0)await fetch(`${API}/tests/bulk-delete`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids:toDel})})
      // Generate steps
      setGenSteps(true)
      toast.info(`Generating test steps for ${selectedIds.size} test case${selectedIds.size!==1?"s":""}…`)
      const sr=await fetch(`${API}/projects/${projectId}/generate-steps-for-selected`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({testCaseIds:Array.from(selectedIds),selectedModule:selectedFlow})
      })
      if(sr.ok){const sd=await sr.json();toast.success(`✅ ${sd.generated} test case${sd.generated!==1?"s":""} added to Tests!`)}
      else{toast.success(`✅ ${selectedIds.size} test cases added to Tests!`)}
      setPhase("done")
      onGenerationComplete(Array.from(selectedIds))
    }catch{toast.error("Failed to add test cases")}
    finally{setConfirming(false);setGenSteps(false)}
  }

  // ── RENDER ──────────────────────────────────────────────────────────────────
  return(
    <Sheet open={open} onOpenChange={v=>{if(!v)handleClose()}}>
      <SheetContent side="right" className="w-full sm:w-[560px] sm:max-w-[560px] p-0 flex flex-col overflow-hidden">
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
                <p className="text-[11px] text-violet-300 mt-0.5">Business Flow Wizard</p>
              </div>
            </div>
            <button onClick={handleClose} className="p-1.5 rounded-md text-violet-300 hover:text-white hover:bg-white/10 transition-colors"><X className="h-4 w-4"/></button>
          </div>
        </div>

        {/* Phase step bar */}
        <StepBar phase={phase}/>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">

          {/* ── PHASE 1: Flow Selection ── */}
          {phase==="flow"&&(
            <div className="p-6 space-y-5">
              <div>
                <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-2"><GitBranch className="h-4 w-4 text-violet-500"/>Select a Business Flow</h3>
                <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-1">Choose a project, then let AI discover the key end-to-end journeys to test.</p>
              </div>

              {/* Project selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide">Project</label>
                {projLoading
                  ?<div className="flex items-center gap-2 text-sm text-slate-400 py-2"><Loader2 className="h-4 w-4 animate-spin"/>Loading projects…</div>
                  :<select value={projectId} onChange={e=>{setProjectId(e.target.value);setFlows([]);setSelectedFlow("")}}
                      className="w-full px-3 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent transition-all">
                      <option value="">— Choose a project —</option>
                      {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>}
              </div>

              {/* Generate flows button */}
              {projectId&&(
                <Button onClick={loadFlows} disabled={flowsLoading} variant="outline" className="w-full border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/30 gap-2">
                  {flowsLoading?<><Loader2 className="h-4 w-4 animate-spin"/>Discovering flows…</>:<><Zap className="h-4 w-4"/>Discover Business Flows</>}
                </Button>
              )}

              {/* Flow list */}
              {flows.length>0&&(
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">{flows.length} flows discovered — select one</p>
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {flows.map((f,i)=>(
                      <button key={i} onClick={()=>setSelectedFlow(f)}
                        className={`w-full text-left px-4 py-3 rounded-xl border-2 text-sm transition-all duration-150 flex items-center gap-3 ${selectedFlow===f?"border-violet-500 bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-200 shadow-sm":"border-slate-200 dark:border-slate-700 hover:border-violet-300 dark:hover:border-violet-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50"}`}>
                        <div className={`w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center border-2 ${selectedFlow===f?"border-violet-500 bg-violet-500":"border-slate-300 dark:border-slate-600"}`}>
                          {selectedFlow===f&&<Check className="h-3 w-3 text-white"/>}
                        </div>
                        <span className="font-medium">{f}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* CTA */}
              <Button onClick={handleFlowNext} disabled={!selectedFlow} className="w-full gap-2 text-white shadow-lg" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
                Continue to Refinement <ChevronDown className="h-4 w-4 rotate-[-90deg]"/>
              </Button>
            </div>
          )}

          {/* ── PHASE 2: Refinement Chat ── */}
          {phase==="refine"&&(
            <div className="flex flex-col h-full min-h-0">
              {/* Flow chip + Skip button */}
              <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-shrink-0">
                <button onClick={()=>setPhase("flow")} className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"><ArrowLeft className="h-4 w-4"/></button>
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="inline-flex items-center gap-1.5 bg-violet-600 text-white text-[11px] font-semibold px-3 py-1 rounded-full truncate max-w-[220px]"><GitBranch className="h-3 w-3 flex-shrink-0"/>{selectedFlow}</span>
                </div>
                <button onClick={handleSkipToGenerate} disabled={refineSending}
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-600 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-200 bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-700 px-3 py-1.5 rounded-lg transition-all hover:bg-violet-100 dark:hover:bg-violet-900/40 flex-shrink-0">
                  <Sparkles className="h-3 w-3"/>Generate Now
                </button>
              </div>

              {/* Chat messages */}
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0">
                {refineHistory.length===0&&refineSending&&(
                  <div className="text-center py-6 space-y-2">
                    <div className="w-10 h-10 rounded-full flex items-center justify-center mx-auto" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}><Cpu className="h-5 w-5 text-white"/></div>
                    <p className="text-xs text-slate-400">AI is preparing a quick context check…</p>
                  </div>
                )}
                {refineHistory.map((m,i)=>(
                  <div key={i}>
                    {m.role==="assistant"?<AiBubble content={m.content}/>:<UserBubble content={m.content}/>}
                  </div>
                ))}
                {refineSending&&refineHistory.length>0&&<AiBubble loading/>}
                <div ref={refineEndRef}/>
              </div>

              {/* Ready-to-generate banner */}
              {readyToGenerate&&(
                <div className="flex-shrink-0 mx-4 mb-3 p-3 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 flex items-center gap-3">
                  <Check className="h-4 w-4 text-emerald-600 flex-shrink-0"/>
                  <p className="text-[12px] text-emerald-700 dark:text-emerald-300 font-medium flex-1">Scope confirmed! Ready to generate test cases.</p>
                  <Button size="sm" onClick={handleRefineGenerate} className="h-8 text-[11px] gap-1 text-white flex-shrink-0" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
                    <Sparkles className="h-3 w-3"/>Generate
                  </Button>
                </div>
              )}

              {/* Input + always-visible Generate button */}
              <div className="flex-shrink-0 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-black/10">
                <div className="px-4 pt-3 pb-2 flex gap-2">
                  <input ref={refineInputRef} value={refineInput} onChange={e=>setRefineInput(e.target.value)}
                    onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendRefineMsg(refineInput)}}}
                    disabled={refineSending} placeholder="Add context or just press Generate…"
                    className="flex-1 px-3 py-2 rounded-lg text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent text-slate-800 dark:text-slate-200 placeholder-slate-400"/>
                  <Button size="icon" className="h-9 w-9 flex-shrink-0 rounded-lg text-white" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}
                    onClick={()=>sendRefineMsg(refineInput)} disabled={!refineInput.trim()||refineSending}>
                    {refineSending?<Loader2 className="h-4 w-4 animate-spin"/>:<Send className="h-4 w-4"/>}
                  </Button>
                </div>
                {/* Always-visible go-to-next-step button */}
                <div className="px-4 pb-3">
                  <Button onClick={readyToGenerate?handleRefineGenerate:handleSkipToGenerate}
                    disabled={refineSending}
                    className="w-full gap-2 text-white h-10 text-sm font-semibold shadow-md" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
                    {refineSending?<><Loader2 className="h-4 w-4 animate-spin"/>Thinking…</>:<><Sparkles className="h-4 w-4"/>Generate Test Cases →</>}
                  </Button>
                  <p className="text-[10px] text-center text-slate-400 mt-1.5">You can type context above or jump straight to generation</p>
                </div>
              </div>
            </div>
          )}

          {/* ── PHASE 3: Preview + Filter Chat ── */}
          {phase==="preview"&&(
            <div className="flex flex-col h-full min-h-0">
              {/* Header bar */}
              <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-2">
                  <button onClick={()=>setPhase("refine")} className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"><ArrowLeft className="h-4 w-4"/></button>
                  <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Review Test Cases</span>
                </div>
                {!tcLoading&&testCases.length>0&&(
                  <Badge variant="outline" className="border-violet-300 text-violet-600 bg-violet-50 dark:bg-violet-950/30 dark:text-violet-300 dark:border-violet-700">
                    {selectedIds.size} / {testCases.length} selected
                  </Badge>
                )}
              </div>

              {/* Loading state */}
              {tcLoading&&(
                <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
                  <div className="relative">
                    <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
                      <Loader2 className="h-8 w-8 text-white animate-spin"/>
                    </div>
                    <div className="absolute inset-0 rounded-full animate-ping opacity-20" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}/>
                  </div>
                  <div className="text-center space-y-1">
                    <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Generating test cases…</p>
                    <p className="text-[11px] text-slate-400">AI is analyzing the workflow scope and creating your test suite.</p>
                  </div>
                </div>
              )}

              {/* Test case list + filter chat */}
              {!tcLoading&&testCases.length>0&&(
                <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
                  {/* Select-all bar */}
                  <div className="flex-shrink-0 px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3 bg-slate-50/50 dark:bg-black/10">
                    <button onClick={toggleAll} className="flex items-center gap-2 text-[12px] font-medium text-slate-600 dark:text-slate-300 hover:text-violet-600 dark:hover:text-violet-400 transition-colors">
                      {allSel?<CheckSquare className="h-4 w-4 text-violet-600"/>:<Square className="h-4 w-4"/>}
                      {allSel?"Deselect all":"Select all"}
                    </button>
                    <span className="text-[11px] text-slate-400">{testCases.length} test cases generated</span>
                    <button onClick={()=>setSelectedIds(new Set(testCases.map(t=>t.id)))} className="ml-auto text-[11px] text-violet-600 dark:text-violet-400 hover:underline flex items-center gap-1"><RefreshCw className="h-3 w-3"/>Reset</button>
                  </div>

                  {/* TC rows */}
                  <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
                    {testCases.map(tc=>{
                      const sel=selectedIds.has(tc.id)
                      return(
                        <div key={tc.id} onClick={()=>toggleTc(tc.id)}
                          className={`flex items-start gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-all duration-150 ${sel?"border-violet-400 dark:border-violet-600 bg-violet-50/60 dark:bg-violet-950/20":"border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-900/50"}`}>
                          <div className={`mt-0.5 w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border-2 transition-colors ${sel?"bg-violet-600 border-violet-600":"border-slate-300 dark:border-slate-600"}`}>
                            {sel&&<Check className="h-3 w-3 text-white"/>}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className={`text-[12px] font-medium leading-snug ${sel?"text-violet-800 dark:text-violet-200":"text-slate-700 dark:text-slate-300"}`}>{tc.name}</p>
                            {tc.description&&<p className="text-[11px] text-slate-400 mt-0.5 truncate">{tc.description}</p>}
                          </div>
                          <PriBadge p={tc.priority}/>
                        </div>
                      )
                    })}
                  </div>

                  {/* AI Filter Chat */}
                  <div className="flex-shrink-0 border-t border-slate-200 dark:border-slate-800">
                    {filterHistory.length>0&&(
                      <div className="max-h-40 overflow-y-auto px-4 py-3 space-y-2.5 bg-slate-50/50 dark:bg-black/10">
                        {filterHistory.map((m,i)=>(
                          <div key={i}>{m.role==="assistant"?<AiBubble content={m.content}/>:<UserBubble content={m.content}/>}</div>
                        ))}
                        {filterSending&&<AiBubble loading/>}
                        <div ref={filterEndRef}/>
                      </div>
                    )}
                    <div className="px-4 py-3 bg-slate-50/80 dark:bg-black/10 space-y-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5"><Cpu className="h-3 w-3"/>AI Filter — refine selection by natural language</p>
                      <div className="flex gap-2">
                        <input ref={filterInputRef} value={filterInput} onChange={e=>setFilterInput(e.target.value)}
                          onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendFilterMsg(filterInput)}}}
                          disabled={filterSending} placeholder='e.g. "Keep only High priority" or "Remove login tests"'
                          className="flex-1 px-3 py-2 rounded-lg text-xs border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-violet-400 text-slate-800 dark:text-slate-200 placeholder-slate-400"/>
                        <Button size="icon" className="h-9 w-9 flex-shrink-0 rounded-lg text-white" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}
                          onClick={()=>sendFilterMsg(filterInput)} disabled={!filterInput.trim()||filterSending}>
                          {filterSending?<Loader2 className="h-3.5 w-3.5 animate-spin"/>:<Send className="h-3.5 w-3.5"/>}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Approve footer */}
              {!tcLoading&&testCases.length>0&&(
                <div className="flex-shrink-0 px-4 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
                  <Button onClick={handleApprove} disabled={selectedIds.size===0||confirming||genSteps} className="w-full gap-2 text-white h-11 text-sm font-semibold shadow-lg" style={{background:"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
                    {(confirming||genSteps)?<><Loader2 className="h-4 w-4 animate-spin"/>{genSteps?"Generating steps…":"Processing…"}</>
                      :<><Sparkles className="h-4 w-4"/>Add {selectedIds.size} Test Case{selectedIds.size!==1?"s":""} to Tests</>}
                  </Button>
                  <p className="text-[10px] text-center text-slate-400 mt-1.5">Selected test cases will get Playwright steps generated automatically.</p>
                </div>
              )}
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
                <Button variant="outline" onClick={()=>{setPhase("flow");setSelectedFlow("");setFlows([]);setRefineHistory([]);setReadyToGenerate(false);setWorkflowScope(null);setTestCases([]);setSelectedIds(new Set());setFilterHistory([])}}
                  className="w-full gap-2 border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/30">
                  <Sparkles className="h-4 w-4"/>Generate Another Flow
                </Button>
              </div>
            </div>
          )}

        </div>{/* end scrollable body */}
      </SheetContent>
    </Sheet>
  )
}
