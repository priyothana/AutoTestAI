"use client"

import { useState, useEffect } from "react"
import { Check, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle
} from "@/components/ui/card"
import { toast } from "sonner"

// Use the configured API URL — falls back to port 4000 for local dev
const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000") + "/api/v1"

// ── Types ──────────────────────────────────────────────────────────────────────
interface Story {
    key: string
    summary: string
    description: string
}

// ── Props ──────────────────────────────────────────────────────────────────────
interface JiraImportPanelProps {
    /** The project ID to fetch Jira stories from */
    projectId: string
    /** Called with the list of selected story lines when the user clicks Import */
    onImport: (stories: string[]) => void
}

export default function JiraImportPanel({ projectId, onImport }: JiraImportPanelProps) {
    // Board & stories state
    const [boardName, setBoardName] = useState("")
    const [stories, setStories] = useState<Story[]>([])
    const [selectedStories, setSelectedStories] = useState<Set<string>>(new Set())
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Auto-load stories when mounted or projectId changes
    useEffect(() => {
        if (projectId) {
            fetchStories()
        }
    }, [projectId])

    const fetchStories = async () => {
        setIsLoading(true)
        setError(null)
        setStories([])
        setSelectedStories(new Set())
        try {
            const res = await fetch(`${API_BASE}/jira/projects/${projectId}/stories`)
            if (!res.ok) {
                const err = await res.json().catch(() => ({}))
                throw new Error(err.detail || err.message || `Failed to fetch stories (HTTP ${res.status})`)
            }
            const data = await res.json()

            // Backend may return a plain array OR { board_name, issues, board_id }
            const issueList: any[] = Array.isArray(data) ? data : (data.issues ?? data.values ?? [])
            const name: string = Array.isArray(data) ? "" : (data.board_name ?? "")

            setBoardName(name)
            setStories(
                issueList.map((issue: any) => ({
                    key: issue.key ?? issue.id ?? "",
                    summary: issue.fields?.summary ?? issue.summary ?? "(no summary)",
                    description: issue.fields?.description ?? issue.description ?? "",
                }))
            )
        } catch (error: any) {
            setError(error.message || "Failed to fetch stories from Jira")
            toast.error(error.message || "Failed to fetch stories from Jira")
        } finally {
            setIsLoading(false)
        }
    }

    const toggleStory = (key: string) => {
        setSelectedStories((prev) => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    const handleImport = () => {
        const selected = stories
            .filter((s) => selectedStories.has(s.key))
            .map((s) => `${s.key}: ${s.summary}`)

        if (selected.length === 0) {
            toast.error("Please select at least one user story to import")
            return
        }

        onImport(selected)
        toast.success(`Imported ${selected.length} user ${selected.length === 1 ? "story" : "stories"} to prompt`)
    }

    // ── Render ─────────────────────────────────────────────────────────────────
    return (
        <Card className="bg-gradient-to-br from-purple-50 to-violet-50 dark:from-purple-950/20 dark:to-violet-950/20 border-purple-200 dark:border-purple-900">
            <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="flex items-center gap-2 text-purple-700 dark:text-purple-400 text-base">
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53zM6.77 6.8a4.36 4.36 0 0 0 4.34 4.34h1.8v1.72a4.36 4.36 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.83-.83H6.77zM2 11.6a4.35 4.35 0 0 0 4.34 4.34h1.8v1.72A4.35 4.35 0 0 0 12.48 22v-9.57a.84.84 0 0 0-.84-.84H2z" />
                    </svg>
                    Import from Jira
                    {boardName && (
                        <span className="text-xs font-normal text-muted-foreground ml-1">— {boardName}</span>
                    )}
                </CardTitle>
                <CardDescription>
                    Select user stories from your connected Jira board.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-4 pb-4 pt-0">
                {isLoading ? (
                    <div className="flex items-center justify-center py-6">
                        <Loader2 className="h-5 w-5 animate-spin text-purple-500" />
                        <span className="ml-2 text-sm text-muted-foreground">Loading stories from Jira...</span>
                    </div>
                ) : error ? (
                    <div className="text-center py-4">
                        <p className="text-sm text-red-600 dark:text-red-400 mb-2">{error}</p>
                        <Button variant="outline" size="sm" onClick={fetchStories}>
                            Retry
                        </Button>
                    </div>
                ) : stories.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-3 text-center">
                        No user stories found in the selected board.
                    </p>
                ) : (
                    <>
                        {/* User stories list */}
                        <div className="space-y-1.5 max-h-[250px] overflow-y-auto">
                            {stories.map((story) => (
                                <label
                                    key={story.key}
                                    className={`flex items-center gap-3 p-2.5 rounded-md cursor-pointer transition-all duration-150 border ${selectedStories.has(story.key)
                                        ? "bg-purple-100 dark:bg-purple-900/30 border-purple-300 dark:border-purple-700"
                                        : "bg-white/60 dark:bg-black/10 border-transparent hover:bg-purple-50 dark:hover:bg-purple-950/20"
                                        }`}
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedStories.has(story.key)}
                                        onChange={() => toggleStory(story.key)}
                                        className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500 accent-purple-600"
                                    />
                                    <div className="flex-1 min-w-0">
                                        <span className="text-xs font-mono text-purple-500 dark:text-purple-400 mr-1.5">
                                            {story.key}
                                        </span>
                                        <span className="text-sm text-gray-800 dark:text-gray-200">
                                            {story.summary}
                                        </span>
                                    </div>
                                </label>
                            ))}
                        </div>

                        {/* Import button */}
                        <Button
                            className="w-full bg-purple-600 hover:bg-purple-700 shadow-md"
                            onClick={handleImport}
                            disabled={selectedStories.size === 0}
                        >
                            Import Selected Stories ({selectedStories.size})
                        </Button>
                    </>
                )}
            </CardContent>
        </Card>
    )
}
