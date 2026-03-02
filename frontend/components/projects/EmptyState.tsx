"use client"

import { FolderOpen } from "lucide-react"
import { Button } from "@/components/ui/button"

interface EmptyStateProps {
    onCreateClick: () => void
}

export function EmptyState({ onCreateClick }: EmptyStateProps) {
    return (
        <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
            <div className="rounded-full bg-muted p-6 mb-4">
                <FolderOpen className="h-12 w-12 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No projects yet</h3>
            <p className="text-muted-foreground mb-6 max-w-sm">
                Create your first project to get started with test automation.
            </p>
            <Button onClick={onCreateClick} size="lg">
                Create New Project
            </Button>
        </div>
    )
}
