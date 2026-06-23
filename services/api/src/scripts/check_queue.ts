import { Queue } from 'bullmq'
import { getRedisOptions } from '../shared/queue/connection.js'
import { QUEUES } from '../shared/queue/queues.js'

async function main() {
  const queue = new Queue(QUEUES.METADATA_SYNC, {
    connection: getRedisOptions() as any
  })

  const jobs = await queue.getJobs(['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'])
  console.log(`Found ${jobs.length} jobs in queue:`)
  for (const job of jobs) {
    console.log({
      id: job.id,
      name: job.name,
      state: await job.getState(),
      data: job.data,
      failedReason: job.failedReason,
      progress: job.progress
    })
  }

  await queue.close()
}

main().catch(console.error).finally(() => process.exit(0))
