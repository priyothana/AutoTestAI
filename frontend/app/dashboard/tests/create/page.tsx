"use client"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Sparkles, GitBranch, PenLine, ArrowLeft, Zap, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"

const options = [
  {
    id: "ai",
    href: "/dashboard/tests/create/generate",
    icon: Sparkles,
    label: "Generate with AI",
    tagline: "Recommended",
    tagColor: "bg-violet-600",
    description:
      "Select your project, discover all business flows from your BRD and metadata, pick the flows you want, and let AI generate a complete, ordered test suite — ready to run.",
    bullets: [
      "Multi-flow selection with smart ordering",
      "Grounded in metadata + BRD + Jira stories",
      "Inline chat filter & approval",
      "One-click sequential flow execution",
    ],
    gradient: "from-violet-600 to-indigo-600",
    border: "border-violet-200 dark:border-violet-800",
    bg: "from-violet-50/80 to-indigo-50/60 dark:from-violet-950/30 dark:to-indigo-950/20",
    hover: "hover:border-violet-400 dark:hover:border-violet-500",
    bulletColor: "text-violet-500",
  },
  {
    id: "jira",
    href: "/dashboard/tests/create/jira",
    icon: GitBranch,
    label: "Import from Jira",
    tagline: "Quick Import",
    tagColor: "bg-blue-500",
    description:
      "Pull user stories and acceptance criteria directly from your Jira board and automatically convert them into executable test cases.",
    bullets: [
      "Maps acceptance criteria to test steps",
      "Preserves Jira issue links & keys",
      "Filters by sprint, epic, or label",
    ],
    gradient: "from-blue-500 to-cyan-500",
    border: "border-blue-200 dark:border-blue-800",
    bg: "from-blue-50/80 to-cyan-50/60 dark:from-blue-950/30 dark:to-cyan-950/20",
    hover: "hover:border-blue-400 dark:hover:border-blue-500",
    bulletColor: "text-blue-500",
  },
  {
    id: "manual",
    href: "/dashboard/tests/create/manual",
    icon: PenLine,
    label: "Manual Test Case",
    tagline: "Full Control",
    tagColor: "bg-slate-500",
    description:
      "Write test steps by hand with full control over every detail. Great for exploratory tests, edge cases, or specific regression scenarios.",
    bullets: [
      "Step-by-step form builder",
      "Supports all action types",
      "Priority & tag assignment",
    ],
    gradient: "from-slate-500 to-slate-600",
    border: "border-slate-200 dark:border-slate-700",
    bg: "from-slate-50/80 to-slate-50/60 dark:from-slate-900/30 dark:to-slate-900/20",
    hover: "hover:border-slate-400 dark:hover:border-slate-500",
    bulletColor: "text-slate-400",
  },
]

export default function CreateTestPage() {
  return (
    <div className="min-h-screen" style={{ background: "radial-gradient(ellipse at 20% 20%, rgba(124,58,237,0.06) 0%, transparent 60%), radial-gradient(ellipse at 80% 80%, rgba(79,70,229,0.06) 0%, transparent 60%)" }}>
      <div className="max-w-5xl mx-auto px-6 py-10 space-y-10">

        {/* Back */}
        <Link href="/dashboard/tests" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors group">
          <ArrowLeft className="h-4 w-4 group-hover:-translate-x-0.5 transition-transform" />
          Back to Tests
        </Link>

        {/* Header */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-widest text-violet-600 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/40 border border-violet-200 dark:border-violet-800">
            <Zap className="h-3 w-3" />
            Create Test Cases
          </div>
          <h1 className="text-3xl font-black tracking-tight text-slate-800 dark:text-slate-100">
            How would you like to create tests?
          </h1>
          <p className="text-slate-500 dark:text-slate-400 max-w-lg mx-auto text-sm leading-relaxed">
            Choose a method below. AI generation covers the most ground, but all paths lead to the same place — an executable test suite.
          </p>
        </div>

        {/* Option cards */}
        <div className="grid gap-5 md:grid-cols-3">
          {options.map((opt) => {
            const Icon = opt.icon
            const isExternal = opt.id !== "ai"
            return (
              <Link key={opt.id} href={opt.href}
                className={`group relative flex flex-col rounded-2xl border-2 ${opt.border} ${opt.hover} bg-gradient-to-br ${opt.bg} p-6 transition-all duration-200 hover:shadow-xl hover:-translate-y-0.5 cursor-pointer`}>

                {/* Tag */}
                <div className="flex items-start justify-between mb-4">
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center bg-gradient-to-br ${opt.gradient} text-white shadow-lg`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <span className={`text-[10px] font-bold uppercase tracking-wider text-white px-2 py-0.5 rounded-full ${opt.tagColor}`}>
                    {opt.tagline}
                  </span>
                </div>

                <h2 className="text-base font-bold text-slate-800 dark:text-slate-100 mb-1.5">{opt.label}</h2>
                <p className="text-[12px] text-slate-500 dark:text-slate-400 leading-relaxed mb-4 flex-1">{opt.description}</p>

                {/* Bullets */}
                <ul className="space-y-1.5 mb-5">
                  {opt.bullets.map((b, i) => (
                    <li key={i} className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${opt.bulletColor.replace("text-", "bg-")}`} />
                      {b}
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <div className={`flex items-center gap-1.5 text-[12px] font-semibold ${opt.bulletColor} group-hover:gap-2.5 transition-all`}>
                  {opt.id === "ai" ? "Start AI Wizard" : opt.id === "jira" ? "Connect Jira" : "Create Manually"}
                  <ChevronRight className="h-3.5 w-3.5" />
                </div>

                {/* Glow effect on hover */}
                <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                  style={{ boxShadow: "inset 0 0 0 2px rgba(124,58,237,0.15)" }} />
              </Link>
            )
          })}
        </div>

        {/* Bottom note */}
        <p className="text-center text-[11px] text-slate-400 dark:text-slate-500">
          All test cases are saved automatically. You can edit, reorder, or delete them at any time from the Tests list.
        </p>
      </div>
    </div>
  )
}
