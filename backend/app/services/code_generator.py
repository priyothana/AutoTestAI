from typing import List, Dict, Any

class CodeGenerator:
    @staticmethod
    def generate_python_script(steps: List[Dict[str, Any]]) -> str:
        lines = [
            "from playwright.sync_api import sync_playwright, expect",
            "",
            "def run(playwright):",
            "    browser = playwright.chromium.launch(headless=True)",
            "    context = browser.new_context()",
            "    page = context.new_page()",
            ""
        ]
        
        for step in steps:
            action = step.get("action")
            target = step.get("target")
            value = step.get("value")
            
            comment = f"    # Step: {action} {target} {value or ''}"
            lines.append(comment)
            
            if action == "NAVIGATE":
                lines.append(f'    page.goto("{value}")')
            elif action == "CLICK":
                lines.append(f'    page.click("{target}")')
            elif action == "TYPE":
                lines.append(f'    page.fill("{target}", "{value}")')
            elif action == "ASSERT_TEXT":
                lines.append(f'    expect(page.locator("{target}")).to_contain_text("{value}")')
            elif action == "WAIT":
                try:
                    ms = int(value)
                    lines.append(f'    page.wait_for_timeout({ms})')
                except:
                    pass
            else:
                lines.append(f"    # Warning: Unsupported action {action}")
        
        lines.append("")
        lines.append("    context.close()")
        lines.append("    browser.close()")
        lines.append("")
        lines.append("with sync_playwright() as playwright:")
        lines.append("    run(playwright)")
        
        return "\n".join(lines)
