"""
Salesforce MCP Service
Provides direct Salesforce API access using Username + Password + Security Token
authentication via the simple-salesforce library.

Follows the MCP Server pattern from: https://github.com/LokiMCPUniverse/salesforce-mcp-server
"""
import logging
from typing import Optional, Dict, Any, List

from simple_salesforce import Salesforce, SalesforceAuthenticationFailed, SalesforceError

logger = logging.getLogger(__name__)


class SalesforceMCPService:
    """
    MCP (Model Context Protocol) service for Salesforce.
    Uses username/password/security_token authentication for direct API access.
    """

    @staticmethod
    def _get_client(
        username: str,
        password: str,
        security_token: str,
        domain: str = "login",
    ) -> Salesforce:
        """
        Create an authenticated Salesforce client connection.

        Args:
            username: Salesforce org username
            password: Salesforce org password
            security_token: Salesforce security token
            domain: 'login' for production, 'test' for sandbox
        """
        try:
            sf = Salesforce(
                username=username,
                password=password,
                security_token=security_token,
                domain=domain,
            )
            return sf
        except SalesforceAuthenticationFailed as e:
            logger.error(f"[mcp] Salesforce authentication failed: {e}")
            raise ValueError(
                "Salesforce authentication failed. Please check your username, "
                "password, and security token."
            )
        except Exception as e:
            logger.error(f"[mcp] Failed to connect to Salesforce: {e}")
            raise ValueError(f"Failed to connect to Salesforce: {str(e)}")

    @staticmethod
    def connect(
        username: str,
        password: str,
        security_token: str,
        domain: str = "login",
    ) -> Dict[str, Any]:
        """
        Validate credentials and return connection information.
        Returns instance_url, org_id, user info, and session_id for frontdoor.jsp.
        """
        sf = SalesforceMCPService._get_client(
            username, password, security_token, domain
        )

        # Get org info
        org_info = {}
        try:
            identity = sf.restful("", method="GET")
            org_info = {
                "instance_url": sf.sf_instance,
                "org_id": sf.sf_instance.split(".")[0] if sf.sf_instance else None,
                "api_version": sf.sf_version,
                "session_id": sf.session_id,
            }
        except Exception:
            org_info = {
                "instance_url": sf.sf_instance,
                "org_id": None,
                "api_version": sf.sf_version,
                "session_id": sf.session_id,
            }

        # Try to get org name via query
        try:
            result = sf.query("SELECT Id, Name FROM Organization LIMIT 1")
            if result.get("records"):
                org_info["org_name"] = result["records"][0].get("Name")
                org_info["org_id"] = result["records"][0].get("Id")
        except Exception:
            pass

        return org_info

    @staticmethod
    def query(
        username: str,
        password: str,
        security_token: str,
        soql: str,
        domain: str = "login",
        include_deleted: bool = False,
    ) -> Dict[str, Any]:
        """
        Execute a SOQL query against the Salesforce org.

        Args:
            soql: SOQL query string (e.g., 'SELECT Id, Name FROM Account LIMIT 10')
            include_deleted: If True, includes soft-deleted records
        """
        sf = SalesforceMCPService._get_client(
            username, password, security_token, domain
        )

        try:
            if include_deleted:
                result = sf.query_all(soql)
            else:
                result = sf.query(soql)

            return {
                "total_size": result.get("totalSize", 0),
                "done": result.get("done", True),
                "records": result.get("records", []),
            }
        except SalesforceError as e:
            logger.error(f"[mcp] SOQL query failed: {e}")
            raise ValueError(f"SOQL query failed: {str(e)}")

    @staticmethod
    def get_record(
        username: str,
        password: str,
        security_token: str,
        object_type: str,
        record_id: str,
        fields: Optional[List[str]] = None,
        domain: str = "login",
    ) -> Dict[str, Any]:
        """
        Get a specific record by its ID.

        Args:
            object_type: Salesforce object type (e.g., 'Account', 'Contact')
            record_id: 15 or 18-character Salesforce record ID
            fields: Optional list of fields to retrieve
        """
        sf = SalesforceMCPService._get_client(
            username, password, security_token, domain
        )

        try:
            sobject = getattr(sf, object_type)
            if fields:
                # Use SOQL for field-specific query
                fields_str = ", ".join(fields)
                result = sf.query(
                    f"SELECT {fields_str} FROM {object_type} WHERE Id = '{record_id}'"
                )
                if result.get("records"):
                    return result["records"][0]
                raise ValueError(f"Record {record_id} not found in {object_type}")
            else:
                return dict(sobject.get(record_id))
        except SalesforceError as e:
            logger.error(f"[mcp] Get record failed: {e}")
            raise ValueError(f"Failed to get record: {str(e)}")

    @staticmethod
    def create_record(
        username: str,
        password: str,
        security_token: str,
        object_type: str,
        data: Dict[str, Any],
        domain: str = "login",
    ) -> Dict[str, Any]:
        """
        Create a new record.

        Args:
            object_type: Salesforce object type (e.g., 'Account', 'Contact')
            data: Field values for the new record
        """
        sf = SalesforceMCPService._get_client(
            username, password, security_token, domain
        )

        try:
            sobject = getattr(sf, object_type)
            result = sobject.create(data)
            return {
                "id": result.get("id"),
                "success": result.get("success", True),
                "errors": result.get("errors", []),
            }
        except SalesforceError as e:
            logger.error(f"[mcp] Create record failed: {e}")
            raise ValueError(f"Failed to create record: {str(e)}")

    @staticmethod
    def update_record(
        username: str,
        password: str,
        security_token: str,
        object_type: str,
        record_id: str,
        data: Dict[str, Any],
        domain: str = "login",
    ) -> Dict[str, Any]:
        """
        Update an existing record.

        Args:
            object_type: Salesforce object type
            record_id: Record ID to update
            data: Fields to update
        """
        sf = SalesforceMCPService._get_client(
            username, password, security_token, domain
        )

        try:
            sobject = getattr(sf, object_type)
            sobject.update(record_id, data)
            return {
                "id": record_id,
                "success": True,
                "message": f"{object_type} record {record_id} updated successfully",
            }
        except SalesforceError as e:
            logger.error(f"[mcp] Update record failed: {e}")
            raise ValueError(f"Failed to update record: {str(e)}")

    @staticmethod
    def delete_record(
        username: str,
        password: str,
        security_token: str,
        object_type: str,
        record_id: str,
        domain: str = "login",
    ) -> Dict[str, Any]:
        """
        Delete a record.

        Args:
            object_type: Salesforce object type
            record_id: Record ID to delete
        """
        sf = SalesforceMCPService._get_client(
            username, password, security_token, domain
        )

        try:
            sobject = getattr(sf, object_type)
            sobject.delete(record_id)
            return {
                "id": record_id,
                "success": True,
                "message": f"{object_type} record {record_id} deleted successfully",
            }
        except SalesforceError as e:
            logger.error(f"[mcp] Delete record failed: {e}")
            raise ValueError(f"Failed to delete record: {str(e)}")

    @staticmethod
    def describe_object(
        username: str,
        password: str,
        security_token: str,
        object_type: str,
        domain: str = "login",
    ) -> Dict[str, Any]:
        """
        Get full metadata description of a Salesforce object.

        Args:
            object_type: Salesforce object type (e.g., 'Account')
        """
        sf = SalesforceMCPService._get_client(
            username, password, security_token, domain
        )

        try:
            sobject = getattr(sf, object_type)
            desc = sobject.describe()
            return {
                "name": desc.get("name"),
                "label": desc.get("label"),
                "label_plural": desc.get("labelPlural"),
                "key_prefix": desc.get("keyPrefix"),
                "createable": desc.get("createable"),
                "updateable": desc.get("updateable"),
                "deletable": desc.get("deletable"),
                "queryable": desc.get("queryable"),
                "fields": [
                    {
                        "name": f.get("name"),
                        "label": f.get("label"),
                        "type": f.get("type"),
                        "length": f.get("length"),
                        "nillable": f.get("nillable"),
                        "createable": f.get("createable"),
                        "updateable": f.get("updateable"),
                        "defaultedOnCreate": f.get("defaultedOnCreate"),
                        # For lookup/reference fields — tells us which object to query for real records
                        "referenceTo": f.get("referenceTo", []),
                        # Dependent picklist support
                        "controllerName": f.get("controllerName", ""),
                        "dependentPicklist": f.get("dependentPicklist", False),
                        "unique": f.get("unique", False),
                        "externalId": f.get("externalId", False),
                        # Lookup filter criteria support
                        "filteredLookupInfo": f.get("filteredLookupInfo") or None,
                        "relationshipName": f.get("relationshipName", ""),
                        "picklistValues": [
                            {"label": v.get("label", v.get("value", "")),
                             "value": v.get("value", ""),
                             "active": v.get("active", True)}
                            for v in (f.get("picklistValues") or []) if v.get("active")
                        ] if f.get("type") in ("picklist", "multipicklist") else [],
                    }
                    for f in desc.get("fields", [])
                ],
                "record_type_infos": desc.get("recordTypeInfos", []),
                "total_fields": len(desc.get("fields", [])),
            }
        except SalesforceError as e:
            logger.error(f"[mcp] Describe object failed: {e}")
            raise ValueError(f"Failed to describe object: {str(e)}")

    @staticmethod
    def get_lookup_filters(
        username: str,
        password: str,
        security_token: str,
        object_name: str,
        domain: str = "login",
    ) -> Dict[str, str]:
        """
        Query the Tooling API for LookupFilter metadata on an object.
        Returns a dict of { field_api_name: "WHERE clause fragment" }.
        
        Example: {"Pay_To__c": "Name = 'DATASIRPI PRIVATE LIMITED' OR Name = 'DataSirpi LLC-FZC'"}
        """
        sf = SalesforceMCPService._get_client(
            username, password, security_token, domain
        )
        filters = {}
        try:
            # Query LookupFilter via Tooling API
            tooling_soql = (
                f"SELECT Id, SourceFieldDefinition.QualifiedApiName, Active, IsOptional "
                f"FROM LookupFilter "
                f"WHERE SourceObject = '{object_name}' AND Active = true"
            )
            result = sf.restful(f"tooling/query", params={"q": tooling_soql})
            records = result.get("records", [])
            
            for rec in records:
                field_def = rec.get("SourceFieldDefinition") or {}
                field_api = field_def.get("QualifiedApiName", "")
                if not field_api:
                    continue
                # Strip object prefix if present (e.g., "Invoice__c.Pay_To__c" → "Pay_To__c")
                if "." in field_api:
                    field_api = field_api.split(".")[-1]
                
                # Query FilterItems for this LookupFilter
                filter_id = rec.get("Id")
                try:
                    items_soql = (
                        f"SELECT Field, Operation, Value, ValueField "
                        f"FROM LookupFilterItem "
                        f"WHERE LookupFilterId = '{filter_id}'"
                    )
                    items_result = sf.restful(f"tooling/query", params={"q": items_soql})
                    items = items_result.get("records", [])
                    
                    where_parts = []
                    for item in items:
                        field = item.get("Field", "")         # e.g., "Account.Name"
                        operation = item.get("Operation", "")  # e.g., "equals"
                        val = item.get("Value", "")            # e.g., "DATASIRPI PRIVATE LIMITED"
                        
                        # Convert field reference: "Account.Name" → "Name" (target object field)
                        if "." in field:
                            field = field.split(".")[-1]
                        
                        # Map operation to SOQL
                        op_map = {
                            "equals": "=", "notEqual": "!=",
                            "contains": "LIKE", "startsWith": "LIKE",
                            "lessThan": "<", "greaterThan": ">",
                            "lessOrEqual": "<=", "greaterOrEqual": ">=",
                        }
                        sql_op = op_map.get(operation, "=")
                        
                        if val:
                            if sql_op == "LIKE" and operation == "contains":
                                where_parts.append(f"{field} LIKE '%{val}%'")
                            elif sql_op == "LIKE" and operation == "startsWith":
                                where_parts.append(f"{field} LIKE '{val}%'")
                            else:
                                where_parts.append(f"{field} {sql_op} '{val}'")
                    
                    if where_parts:
                        filters[field_api] = " OR ".join(where_parts)
                        print(f"[MCP-FILTER] {object_name}.{field_api}: {filters[field_api]}")
                except Exception as ie:
                    print(f"[MCP-FILTER] ⚠ Could not query filter items for {field_api}: {ie}")
                    
        except Exception as e:
            print(f"[MCP-FILTER] ⚠ Tooling API query failed for {object_name}: {e}")
        
        return filters

    @staticmethod
    def search(
        username: str,
        password: str,
        security_token: str,
        sosl_query: str,
        domain: str = "login",
    ) -> Dict[str, Any]:
        """
        Execute a SOSL (Salesforce Object Search Language) search.

        Args:
            sosl_query: SOSL query (e.g., "FIND {John} IN NAME FIELDS RETURNING Contact(Id, Name)")
        """
        sf = SalesforceMCPService._get_client(
            username, password, security_token, domain
        )

        try:
            result = sf.search(sosl_query)
            return {
                "search_records": result.get("searchRecords", []),
                "total_size": len(result.get("searchRecords", [])),
            }
        except SalesforceError as e:
            logger.error(f"[mcp] SOSL search failed: {e}")
            raise ValueError(f"Search failed: {str(e)}")

    @staticmethod
    def get_limits(
        username: str,
        password: str,
        security_token: str,
        domain: str = "login",
    ) -> Dict[str, Any]:
        """
        Get organization API limits and usage.
        """
        sf = SalesforceMCPService._get_client(
            username, password, security_token, domain
        )

        try:
            limits = sf.limits()
            # Return the most relevant limits
            key_limits = {}
            important_keys = [
                "DailyApiRequests", "DailyBulkApiRequests",
                "DailyAsyncApexExecutions", "DailyStreamingApiEvents",
                "DataStorageMB", "FileStorageMB",
                "SingleEmail", "MassEmail",
                "HourlyTimeBasedWorkflow",
            ]
            for key in important_keys:
                if key in limits:
                    key_limits[key] = limits[key]

            return {
                "key_limits": key_limits,
                "all_limits": limits,
            }
        except SalesforceError as e:
            logger.error(f"[mcp] Get limits failed: {e}")
            raise ValueError(f"Failed to get org limits: {str(e)}")
