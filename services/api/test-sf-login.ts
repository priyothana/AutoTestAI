import { getIntegrationByProject, getDecryptedTokens } from './src/modules/project/project.service.js'
import jsforce from 'jsforce'

async function tryLogin() {
  const projectId = 'dd93230c-a60b-48e9-9540-2e9a42cd4565'
  const integration = await getIntegrationByProject(projectId)
  const tokens = await getDecryptedTokens(integration!.id)
  
  console.log('Login URL:', integration!.salesforce_login_url)
  console.log('Username:', tokens.username)
  console.log('Password length:', tokens.password?.length)
  console.log('SecToken length:', tokens.security_token?.length)
  
  const conn = new jsforce.Connection({ loginUrl: integration!.salesforce_login_url! })
  try {
    await conn.login(tokens.username!, `${tokens.password!}${tokens.security_token ?? ''}`)
    console.log('Login SUCCESS! Token:', conn.accessToken?.substring(0, 5) + '...')
  } catch (err: any) {
    console.error('Login FAILED:', err.errorCode, err.message)
  }
}

tryLogin().catch(console.error)
