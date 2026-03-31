/**
 * Salesforce Module — Shared TypeScript Interfaces
 *
 * All types shared across lib/ files and salesforce.service.ts live here.
 * No business logic — pure type definitions.
 */

// ─── Credential shape ─────────────────────────────────────────────

/**
 * Credential shape read from Integration table via project.service.ts.
 * authType determines which fields are populated.
 */
export interface SFCredential {
  instanceUrl: string
  authType: 'password' | 'oauth2'
  /** username+password flow */
  username?: string
  password?: string
  securityToken?: string
  /** OAuth2 flow */
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
}

// ─── Error class ──────────────────────────────────────────────────

/**
 * Typed error wrapper — every JSforce error is converted to this before
 * being rethrown. Callers only ever see SalesforceError, never raw jsforce
 * exceptions.
 */
export class SalesforceError extends Error {
  public readonly errorCode: string
  public readonly statusCode: number
  public readonly objectName?: string

  constructor(opts: {
    message: string
    errorCode?: string
    statusCode?: number
    objectName?: string
  }) {
    super(opts.message)
    this.name = 'SalesforceError'
    this.errorCode = opts.errorCode ?? 'UNKNOWN_ERROR'
    this.statusCode = opts.statusCode ?? 500
    this.objectName = opts.objectName
  }
}

// ─── Metadata result types ────────────────────────────────────────

export interface PicklistValue {
  label: string
  value: string
  active: boolean
  defaultValue: boolean
}

export interface RecordTypeInfo {
  recordTypeId: string
  name: string
  developerName: string
  available: boolean
  master: boolean
}

export interface ChildRelationship {
  childSObject: string
  field: string
  relationshipName: string | null
}

export interface FieldMetadata {
  name: string
  label: string
  type: string
  required: boolean
  updateable: boolean
  createable: boolean
  length?: number
  picklistValues: PicklistValue[]
  referenceTo: string[]
  relationshipName: string | null
}

export interface ObjectMetadata {
  name: string
  label: string
  fields: FieldMetadata[]
  recordTypeInfos: RecordTypeInfo[]
  childRelationships: ChildRelationship[]
}

export interface GlobalObjectSummary {
  name: string
  label: string
  queryable: boolean
  createable: boolean
  updateable: boolean
}

// ─── Dependent picklist ───────────────────────────────────────────

export interface DependentPicklistMap {
  controllerField: string
  dependentField: string
  mapping: {
    [controllerValue: string]: PicklistValue[]
  }
}
