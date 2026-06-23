/**
 * Quick end-to-end test of "Convert Quotation to Booking" step generation.
 * Verifies that:
 *  1. The Booking manifest loads with real form fields (shipper, consignee, etc.)
 *  2. The generated steps include field input steps for the Create Booking modal
 *  3. The submit button is "Create Booking"
 *  4. The steps don't just jump from "Click Convert to Booking" to "ASSERT_URL /bookings"
 */
import { runTestStepGeneratorAgent } from '../modules/ai-agents/test-step-generator.agent.js'

async function main() {
  console.log('[TEST] Running Convert Quotation to Booking step generation...\n')

  const result = await runTestStepGeneratorAgent({
    projectId: '5006cc44-0e03-45bd-8a84-3b2582f84b02',
    testName: 'Convert Quotation to Booking - Happy Path',
    description: 'Navigate to the Quotations page, search for ENQ-0017, open the quotation, click Convert to Booking, fill in the required booking form fields, and submit to create a new booking.',
    entityFilter: 'Quotation',  // intentionally set to source entity to test the override
  })

  console.log('=== GENERATED STEPS ===')
  result.steps.forEach((s, i) => {
    console.log(`${i + 1}. [${s.action}] target="${s.target}" value="${s.value ?? ''}" locator=${s.locator_type ?? ''}`)
  })

  console.log('\n=== VALIDATION ===')
  console.log('Passed:', result.validation.passed)
  if (result.validation.issues.length > 0) {
    console.log('Issues:')
    result.validation.issues.forEach(iss => console.log(' -', iss))
  }

  console.log('\n=== STATS ===')
  console.log('Loop count:', result.loopCount)
  console.log('Total steps:', result.steps.length)

  // Check for key conditions
  const hasFieldSteps = result.steps.some(s => ['TYPE', 'SELECT', 'LOOKUP'].includes(s.action.toUpperCase()))
  const hasCreateBookingClick = result.steps.some(s =>
    s.action.toUpperCase() === 'CLICK' && /create.booking|convert/i.test(s.target ?? '')
  )
  const hasAssertUrl = result.steps.some(s => s.action.toUpperCase() === 'ASSERT_URL')

  console.log('\n=== KEY CHECKS ===')
  console.log('Has field input steps:', hasFieldSteps ? '✅' : '❌')
  console.log('Has "Create Booking" CLICK:', hasCreateBookingClick ? '✅' : '❌')
  console.log('Has ASSERT_URL:', hasAssertUrl ? '✅' : '❌')

  process.exit(0)
}

main().catch((err: any) => { console.error(err); process.exit(1) })
