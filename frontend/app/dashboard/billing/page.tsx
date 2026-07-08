"use client"

import { useState } from "react"
import { CreditCard, Download, Zap, ShieldCheck, DollarSign, Calendar, ArrowRight, Loader2, Save } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"

export default function BillingPage() {
    const [isUpdatingCard, setIsUpdatingCard] = useState(false)
    const [isSavingCard, setIsSavingCard] = useState(false)

    // Mock usage metrics
    const usage = {
        executions: { current: 2450, limit: 10000, percentage: 24.5 },
        projects: { current: 5, limit: 15, percentage: 33.3 },
        crawledPages: { current: 480, limit: 2000, percentage: 24.0 }
    }

    // Mock Invoices
    const invoices = [
        { id: "INV-2026-004", date: "July 1, 2026", amount: "$249.00", status: "Paid" },
        { id: "INV-2026-003", date: "June 1, 2026", amount: "$249.00", status: "Paid" },
        { id: "INV-2026-002", date: "May 1, 2026", amount: "$249.00", status: "Paid" },
        { id: "INV-2026-001", date: "April 1, 2026", amount: "$249.00", status: "Paid" }
    ]

    const handleUpdateCard = (e: React.FormEvent) => {
        e.preventDefault()
        setIsSavingCard(true)
        setTimeout(() => {
            setIsSavingCard(false)
            setIsUpdatingCard(false)
            toast.success("Payment details updated successfully!")
        }, 1500)
    }

    const triggerDownloadInvoice = (invId: string) => {
        toast.success(`Downloading invoice ${invId}...`)
    }

    return (
        <div className="space-y-8 max-w-5xl mx-auto">
            {/* Header */}
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Billing & Plans</h2>
                <p className="text-muted-foreground">Manage your subscription plans, view usage stats, and download invoices.</p>
            </div>

            {/* Plan Info and Payment Cards */}
            <div className="grid gap-6 md:grid-cols-3">
                {/* Subscription Tier Details */}
                <Card className="md:col-span-2 relative overflow-hidden flex flex-col justify-between" style={{ borderLeft: "4px solid var(--color-brand)" }}>
                    <CardHeader>
                        <div className="flex justify-between items-start">
                            <div>
                                <Badge className="mb-2 bg-purple-100 hover:bg-purple-100 text-purple-700 border-purple-200">Scale Plan</Badge>
                                <CardTitle className="text-2xl font-bold flex items-center gap-2">
                                    <Zap className="h-5 w-5 text-amber-500 fill-amber-500" />
                                    AutoTest Scale Pro
                                </CardTitle>
                            </div>
                            <div className="text-right">
                                <span className="text-3xl font-extrabold">$249</span>
                                <span className="text-muted-foreground text-sm">/month</span>
                            </div>
                        </div>
                        <CardDescription className="pt-2">
                            For growing engineering teams requiring headful self-healing runs, deep repository crawls, and visual Playwright reports.
                        </CardDescription>
                    </CardHeader>

                    <CardContent className="space-y-4">
                        <div className="flex items-center gap-2 text-sm">
                            <ShieldCheck className="h-4 w-4 text-green-500" />
                            <span>Renewal date: <strong>August 1, 2026</strong> (automatic via Visa card ending in 4242)</span>
                        </div>
                    </CardContent>

                    <CardFooter className="bg-muted/30 border-t p-4 flex flex-wrap gap-2 justify-between items-center">
                        <span className="text-xs text-muted-foreground">Looking for custom controls or Dedicated Runners?</span>
                        <Button variant="outline" size="sm" className="flex items-center gap-1.5" onClick={() => toast.info("Opening custom enterprise quotes request...")}>
                            Upgrade to Enterprise <ArrowRight className="h-3 w-3" />
                        </Button>
                    </CardFooter>
                </Card>

                {/* Credit Card Info */}
                <Card className="flex flex-col justify-between">
                    <CardHeader>
                        <CardTitle className="text-lg font-semibold flex items-center gap-2">
                            <CreditCard className="h-5 w-5 text-muted-foreground" />
                            Payment Method
                        </CardTitle>
                        <CardDescription>Primary method for monthly billing.</CardDescription>
                    </CardHeader>

                    <CardContent className="space-y-4 flex-1">
                        {!isUpdatingCard ? (
                            <div className="p-4 rounded-xl border border-dashed flex flex-col justify-center gap-2 h-full bg-muted/20">
                                <div className="flex items-center gap-3">
                                    <div className="bg-blue-600 text-white font-bold px-2 py-1 rounded text-xs tracking-wider">
                                        VISA
                                    </div>
                                    <div className="text-sm font-medium">
                                        •••• •••• •••• 4242
                                    </div>
                                </div>
                                <div className="text-xs text-muted-foreground mt-1 flex justify-between">
                                    <span>Expires: 12/28</span>
                                    <span>Primary Card</span>
                                </div>
                            </div>
                        ) : (
                            <form onSubmit={handleUpdateCard} className="space-y-3">
                                <div className="space-y-1">
                                    <Label htmlFor="cardNumber">Card Number</Label>
                                    <Input id="cardNumber" placeholder="4111 1111 1111 4242" defaultValue="4111 1111 1111 4242" required />
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <div className="space-y-1">
                                        <Label htmlFor="expiry">Expiration</Label>
                                        <Input id="expiry" placeholder="12/28" required />
                                    </div>
                                    <div className="space-y-1">
                                        <Label htmlFor="cvv">CVV</Label>
                                        <Input id="cvv" placeholder="•••" required />
                                    </div>
                                </div>
                                <div className="flex gap-2 pt-2">
                                    <Button size="sm" type="submit" className="flex-1" disabled={isSavingCard}>
                                        {isSavingCard ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                                        Save
                                    </Button>
                                    <Button size="sm" variant="ghost" type="button" className="flex-1" onClick={() => setIsUpdatingCard(false)}>
                                        Cancel
                                    </Button>
                                </div>
                            </form>
                        )}
                    </CardContent>

                    {!isUpdatingCard && (
                        <CardFooter className="border-t p-4">
                            <Button variant="outline" size="sm" className="w-full" onClick={() => setIsUpdatingCard(true)}>
                                Update Card Details
                            </Button>
                        </CardFooter>
                    )}
                </Card>
            </div>

            {/* Usage Metrics */}
            <div className="grid gap-6 md:grid-cols-3">
                {/* Executions meter */}
                <Card>
                    <CardHeader className="pb-2">
                        <div className="flex justify-between items-center text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            <span>Test Executions</span>
                            <span className="font-bold text-foreground">{usage.executions.current} / {usage.executions.limit}</span>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <div className="h-2 rounded-full overflow-hidden bg-muted">
                            <div className="h-full bg-purple-600 rounded-full" style={{ width: `${usage.executions.percentage}%` }} />
                        </div>
                        <p className="text-xs text-muted-foreground">{usage.executions.limit - usage.executions.current} test executions remaining this month.</p>
                    </CardContent>
                </Card>

                {/* Projects meter */}
                <Card>
                    <CardHeader className="pb-2">
                        <div className="flex justify-between items-center text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            <span>Active Environments</span>
                            <span className="font-bold text-foreground">{usage.projects.current} / {usage.projects.limit}</span>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <div className="h-2 rounded-full overflow-hidden bg-muted">
                            <div className="h-full bg-blue-600 rounded-full" style={{ width: `${usage.projects.percentage}%` }} />
                        </div>
                        <p className="text-xs text-muted-foreground">{usage.projects.limit - usage.projects.current} active project slots remaining.</p>
                    </CardContent>
                </Card>

                {/* Crawled pages meter */}
                <Card>
                    <CardHeader className="pb-2">
                        <div className="flex justify-between items-center text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            <span>Indexed Pages</span>
                            <span className="font-bold text-foreground">{usage.crawledPages.current} / {usage.crawledPages.limit}</span>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <div className="h-2 rounded-full overflow-hidden bg-muted">
                            <div className="h-full bg-green-600 rounded-full" style={{ width: `${usage.crawledPages.percentage}%` }} />
                        </div>
                        <p className="text-xs text-muted-foreground">{usage.crawledPages.limit - usage.crawledPages.current} page schemas remaining in limits.</p>
                    </CardContent>
                </Card>
            </div>

            {/* Invoice History */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg font-semibold flex items-center gap-2">
                        <Calendar className="h-5 w-5 text-muted-foreground" />
                        Billing & Invoice History
                    </CardTitle>
                    <CardDescription>View your past payment statements and download PDFs.</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="pl-6">Invoice ID</TableHead>
                                <TableHead>Billing Date</TableHead>
                                <TableHead>Amount</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead className="text-right pr-6">Statement</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {invoices.map((inv) => (
                                <TableRow key={inv.id}>
                                    <TableCell className="font-mono font-medium pl-6">{inv.id}</TableCell>
                                    <TableCell>{inv.date}</TableCell>
                                    <TableCell>{inv.amount}</TableCell>
                                    <TableCell>
                                        <Badge style={{ backgroundColor: '#D6E5BD', color: '#15803d', borderColor: '#c2d1a7' }} variant="outline">
                                            {inv.status}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="text-right pr-6">
                                        <Button variant="ghost" size="icon" title="Download invoice" onClick={() => triggerDownloadInvoice(inv.id)}>
                                            <Download className="h-4 w-4" />
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    )
}
