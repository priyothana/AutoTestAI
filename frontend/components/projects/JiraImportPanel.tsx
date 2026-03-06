"use client"

import { useState } from "react"
import { ExternalLink, Check, Loader2, Link2, Unlink } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle
} from "@/components/ui/card"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"

// ── Mock data ──────────────────────────────────────────────────────────────────
const MOCK_BOARDS: Record<string, { id: string; name: string }[]> = {
    boards: [
        { id: "board-1", name: "Product Development" },
        { id: "board-2", name: "QA Board" },
        { id: "board-3", name: "Salesforce Automation" },
    ],
}

const MOCK_STORIES: Record<string, { key: string; title: string }[]> = {
    "board-1": [
        { key: "JIRA-101", title: "Create Account Feature" },
        { key: "JIRA-102", title: "Validate Opportunity Workflow" },
        { key: "JIRA-103", title: "LWC Component Rendering" },
    ],
    "board-2": [
        { key: "JIRA-201", title: "Regression Suite Setup" },
        { key: "JIRA-202", title: "Cross-browser Validation" },
        { key: "JIRA-203", title: "Mobile Responsive Testing" },
    ],
    "board-3": [
        { key: "JIRA-301", title: "Lead Conversion Flow" },
        { key: "JIRA-302", title: "Opportunity Stage Transitions" },
        { key: "JIRA-303", title: "Contact Merge Automation" },
    ],
}

// ── Props ──────────────────────────────────────────────────────────────────────
interface JiraImportPanelProps {
    /** Called with the list of selected story titles when the user clicks Import */
    onImport: (stories: string[]) => void
}

export default function JiraImportPanel({ onImport }: JiraImportPanelProps) {
    // Connection state
    const [isConnected, setIsConnected] = useState(false)
    const [isConnecting, setIsConnecting] = useState(false)
    const [dialogOpen, setDialogOpen] = useState(false)

    // Form fields (demo only)
    const [domain, setDomain] = useState("")
    const [email, setEmail] = useState("")
    const [apiToken, setApiToken] = useState("")

    // Board & stories state
    const [selectedBoard, setSelectedBoard] = useState("")
    const [selectedStories, setSelectedStories] = useState<Set<string>>(new Set())

    // ── Handlers ───────────────────────────────────────────────────────────────
    const handleConnect = async () => {
        if (!domain || !email || !apiToken) {
            toast.error("Please fill in all connection fields")
            return
        }
        setIsConnecting(true)
        // Simulate API delay
        await new Promise((r) => setTimeout(r, 1500))
        setIsConnecting(false)
        setIsConnected(true)
        setDialogOpen(false)
        setSelectedBoard(MOCK_BOARDS.boards[0].id)
        toast.success("Connected to Jira successfully (Demo Mode)", {
            icon: <Check className="h-4 w-4" />,
        })
    }

    const handleDisconnect = () => {
        setIsConnected(false)
        setSelectedBoard("")
        setSelectedStories(new Set())
        setDomain("")
        setEmail("")
        setApiToken("")
        toast.info("Disconnected from Jira")
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
        const stories = (MOCK_STORIES[selectedBoard] || [])
            .filter((s) => selectedStories.has(s.key))
            .map((s) => s.title)

        if (stories.length === 0) {
            toast.error("Please select at least one user story to import")
            return
        }

        onImport(stories)
        toast.success(`Imported ${stories.length} user ${stories.length === 1 ? "story" : "stories"} to prompt`)
    }

    const currentStories = MOCK_STORIES[selectedBoard] || []

    // ── Render ─────────────────────────────────────────────────────────────────
    return (
        <Card className="bg-gradient-to-br from-purple-50 to-violet-50 dark:from-purple-950/20 dark:to-violet-950/20 border-purple-200 dark:border-purple-900">
            <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="flex items-center gap-2 text-purple-700 dark:text-purple-400 text-base">
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53zM6.77 6.8a4.36 4.36 0 0 0 4.34 4.34h1.8v1.72a4.36 4.36 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.83-.83H6.77zM2 11.6a4.35 4.35 0 0 0 4.34 4.34h1.8v1.72A4.35 4.35 0 0 0 12.48 22v-9.57a.84.84 0 0 0-.84-.84H2z" />
                    </svg>
                    Import from Jira
                </CardTitle>
                <CardDescription>
                    Import user stories from your Jira board.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-4 pb-4 pt-0">
                {!isConnected ? (
                    /* ── Not connected: show Connect button ──────────────────── */
                    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                        <DialogTrigger asChild>
                            <Button
                                variant="outline"
                                className="w-full border-purple-300 dark:border-purple-800 hover:bg-purple-100 dark:hover:bg-purple-900/30 text-purple-700 dark:text-purple-300"
                            >
                                <Link2 className="mr-2 h-4 w-4" />
                                Connect to Jira
                            </Button>
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-md">
                            <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                    <svg className="h-5 w-5 text-purple-600" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53zM6.77 6.8a4.36 4.36 0 0 0 4.34 4.34h1.8v1.72a4.36 4.36 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.83-.83H6.77zM2 11.6a4.35 4.35 0 0 0 4.34 4.34h1.8v1.72A4.35 4.35 0 0 0 12.48 22v-9.57a.84.84 0 0 0-.84-.84H2z" />
                                    </svg>
                                    Connect to Jira
                                </DialogTitle>
                                <DialogDescription>
                                    Enter your Jira credentials to import user stories. (Demo Mode – no real connection is made)
                                </DialogDescription>
                            </DialogHeader>
                            <div className="space-y-4 py-2">
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Jira Domain</label>
                                    <Input
                                        placeholder="https://yourcompany.atlassian.net"
                                        value={domain}
                                        onChange={(e) => setDomain(e.target.value)}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Email</label>
                                    <Input
                                        type="email"
                                        placeholder="you@company.com"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">API Token</label>
                                    <Input
                                        type="password"
                                        placeholder="Enter your Jira API token"
                                        value={apiToken}
                                        onChange={(e) => setApiToken(e.target.value)}
                                    />
                                </div>
                            </div>
                            <DialogFooter>
                                <Button
                                    onClick={handleConnect}
                                    disabled={isConnecting}
                                    className="w-full bg-purple-600 hover:bg-purple-700"
                                >
                                    {isConnecting ? (
                                        <>
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            Connecting...
                                        </>
                                    ) : (
                                        <>
                                            <ExternalLink className="mr-2 h-4 w-4" />
                                            Connect
                                        </>
                                    )}
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>
                ) : (
                    /* ── Connected: show board picker, stories, import ───────── */
                    <>
                        {/* Connection status */}
                        <div className="flex items-center justify-between">
                            <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-300 dark:border-green-800">
                                <Check className="mr-1 h-3 w-3" />
                                Connected (Demo Mode)
                            </Badge>
                            <button
                                onClick={handleDisconnect}
                                className="text-xs text-muted-foreground hover:text-red-500 transition-colors flex items-center gap-1"
                            >
                                <Unlink className="h-3 w-3" />
                                Disconnect
                            </button>
                        </div>

                        {/* Board selector */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-purple-700 dark:text-purple-400">
                                Select Jira Board
                            </label>
                            <select
                                value={selectedBoard}
                                onChange={(e) => {
                                    setSelectedBoard(e.target.value)
                                    setSelectedStories(new Set())
                                }}
                                className="w-full h-9 rounded-md border border-purple-200 dark:border-purple-800 bg-white/50 dark:bg-black/20 px-3 py-1 text-sm shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-purple-400 cursor-pointer"
                            >
                                {MOCK_BOARDS.boards.map((board) => (
                                    <option key={board.id} value={board.id}>
                                        {board.name}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* User stories list */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-purple-700 dark:text-purple-400">
                                User Stories
                            </label>
                            <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                                {currentStories.map((story) => (
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
                                                {story.title}
                                            </span>
                                        </div>
                                    </label>
                                ))}
                            </div>
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
