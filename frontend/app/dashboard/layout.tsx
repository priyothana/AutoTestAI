"use client"

import { use, useState, useEffect } from "react"
import { usePathname } from "next/navigation"
import {
    LogOut,
    Menu,
    Bell
} from "lucide-react"
import ThemeToggle from "@/components/shared/ThemeToggle"
import Logo from "@/components/shared/Logo"
import Sidebar from "@/components/shared/Sidebar"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

interface DashboardLayoutProps {
    children: React.ReactNode
    params: Promise<any>
}

export default function DashboardLayout({ children, params }: DashboardLayoutProps) {
    use(params)
    const pathname = usePathname()
    const [mounted, setMounted] = useState(false)

    useEffect(() => {
        setMounted(true)
    }, [])

    const handleLogout = () => {
        if (typeof window !== "undefined") {
            localStorage.removeItem("token")
            window.location.href = "/"
        }
    }

    return (
        <div className="flex min-h-screen" style={{ backgroundColor: 'var(--color-bg-base)' }}>
            {/* Desktop Sidebar */}
            <aside className="hidden md:block flex-shrink-0">
                <Sidebar pathname={pathname} />
            </aside>

            <div className="flex flex-1 flex-col overflow-auto">
                {/* Header */}
                <header className="flex h-16 items-center justify-between px-6 sticky top-0 z-20 backdrop-blur-md" style={{ backgroundColor: 'color-mix(in srgb, var(--color-bg-elevated) 85%, transparent)', borderBottom: '1px solid var(--color-border-sem)' }}>
                    <div className="flex items-center gap-4 md:hidden">
                        {mounted ? (
                            <Sheet>
                                <SheetTrigger asChild>
                                    <Button variant="ghost" size="icon" className="md:hidden">
                                        <Menu className="h-5 w-5" />
                                        <span className="sr-only">Toggle menu</span>
                                    </Button>
                                </SheetTrigger>
                                <SheetContent side="left" className="w-[280px] p-0" style={{ backgroundColor: 'transparent', border: 'none' }}>
                                    <Sidebar pathname={pathname} mobile />
                                </SheetContent>
                            </Sheet>
                        ) : (
                            <Button variant="ghost" size="icon" className="md:hidden">
                                <Menu className="h-5 w-5" />
                                <span className="sr-only">Toggle menu</span>
                            </Button>
                        )}
                        <span className="md:hidden"><Logo size="sm" /></span>
                    </div>

                    <div className="flex flex-1 items-center justify-end gap-4">
                        <ThemeToggle />
                        <Button variant="ghost" size="icon">
                            <Bell className="h-5 w-5" />
                        </Button>
                        {mounted ? (
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" className="relative h-8 w-8 rounded-full">
                                        <Avatar className="h-8 w-8">
                                            <AvatarImage src="https://github.com/shadcn.png" alt="User" />
                                            <AvatarFallback>JD</AvatarFallback>
                                        </Avatar>
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuLabel>My Account</DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem>Profile</DropdownMenuItem>
                                    <DropdownMenuItem>Billing</DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        style={{ color: 'var(--color-danger)' }}
                                        className="cursor-pointer"
                                        onClick={handleLogout}
                                    >
                                        <LogOut className="mr-2 h-4 w-4" />
                                        Log out
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        ) : (
                            <Button variant="ghost" className="relative h-8 w-8 rounded-full">
                                <Avatar className="h-8 w-8">
                                    <AvatarImage src="https://github.com/shadcn.png" alt="User" />
                                    <AvatarFallback>JD</AvatarFallback>
                                </Avatar>
                            </Button>
                        )}
                    </div>
                </header>

                {/* Main Content */}
                <main className="flex-1 p-6 page-in">
                    {children}
                </main>
            </div>
        </div>
    )
}
