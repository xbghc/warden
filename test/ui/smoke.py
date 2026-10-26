"""Exercise the packaged webview against an isolated Git fixture; requires Python Playwright."""
import json
import os
from pathlib import Path
import subprocess
import sys
from playwright.sync_api import sync_playwright, expect

artifacts = Path(os.environ.get('WARDEN_UI_ARTIFACTS', '/tmp/warden-ui-artifacts'))
artifacts.mkdir(parents=True, exist_ok=True)
host = subprocess.Popen(['node', '--import', 'tsx', 'test/ui/harness.ts'], stdout=subprocess.PIPE, text=True)
try:
    info = json.loads(host.stdout.readline())
    origin = f"http://127.0.0.1:{info['port']}"
    with sync_playwright() as playwright:
        executable = os.environ.get('CHROMIUM_PATH') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
        browser = playwright.chromium.launch(executable_path=executable, headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1100, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        for surface in ['task', 'preview', 'history', 'rebase']:
            page.goto(origin + '?surface=' + surface)
            expect(page.get_by_role('button', name='选择主开发分支', exact=True)).to_be_visible()
            expect(page.get_by_role('button')).to_have_count(1)
            expect(page.get_by_role('textbox')).to_have_count(0)
        page.set_viewport_size({'width': 360, 'height': 700})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.screenshot(path=str(artifacts / 'setup-branch.png'), full_page=True)
        page.goto(origin)
        page.get_by_role('button', name='选择主开发分支', exact=True).click()
        expect(page.get_by_role('heading', name='新增任务', exact=True)).to_be_visible()
        page.set_viewport_size({'width': 1100, 'height': 900})
        page.get_by_role('textbox', name='标题', exact=True).fill('订单接口')
        page.get_by_role('textbox', name='说明', exact=True).fill('增加查询参数\n保留旧调用方式')
        page.get_by_role('button', name='添加任务', exact=True).click()
        expect(page.get_by_role('heading', name='订单接口', exact=True)).to_be_visible()
        page.get_by_role('textbox', name='执行者（可选）', exact=True).fill('worker-a')
        page.get_by_role('button', name='创建工作区', exact=True).click()
        expect(page.get_by_role('button', name='打开变更', exact=True)).to_be_visible(timeout=30000)
        expect(page.get_by_text('复用已有工作区', exact=True)).to_have_count(0)
        page.screenshot(path=str(artifacts / 'task.png'), full_page=True)

        page.goto(origin + '?surface=settings')
        expect(page.get_by_role('heading', name='ACP Agent', exact=True)).to_be_visible()
        expect(page.locator('.acp-setup pre')).not_to_be_visible()
        page.get_by_text('ACP 配置说明与示例', exact=True).click()
        expect(page.locator('.acp-setup pre')).to_contain_text('warden.acpAgents')
        page.get_by_role('button', name='配置 Agent', exact=True).click()
        page.wait_for_function("window.__actions.some(action => action.type === 'settings.agents')")
        page.screenshot(path=str(artifacts / 'settings-acp.png'), full_page=True)
        page.get_by_text('ACP 配置说明与示例', exact=True).click()
        page.get_by_role('textbox', name='工作区初始化脚本', exact=True).fill('echo workspace-ready')
        page.get_by_role('textbox', name='预览 setup', exact=True).fill('echo preview-ready')
        page.get_by_role('button', name='保存脚本配置', exact=True).click()
        page.wait_for_function('window.__settingsSaved === true')
        page.reload()
        expect(page.get_by_role('textbox', name='预览 setup', exact=True)).to_have_value('echo preview-ready')

        page.goto(origin + '?surface=preview')
        page.get_by_role('button', name='立即同步', exact=True).click()
        expect(page.get_by_text('成功', exact=True)).to_be_visible(timeout=30000)
        page.get_by_text('输出 · 退出码 0', exact=True).click()
        expect(page.get_by_text('preview-ready', exact=True)).to_be_visible()
        page.screenshot(path=str(artifacts / 'preview.png'), full_page=True)

        page.goto(origin + '?surface=history')
        expect(page.get_by_role('combobox', name='编排起点', exact=True)).to_be_visible()
        choices = page.get_by_role('combobox', name='编排起点', exact=True).locator('option').all()
        page.get_by_role('combobox', name='编排起点', exact=True).select_option(choices[-1].get_attribute('value'))
        page.get_by_role('button', name='创建历史草稿', exact=True).click()
        page.get_by_role('textbox', name='提交信息 1', exact=True).fill('整理接口说明\n\n保留最终文件内容')
        page.get_by_role('button', name='预览改写结果', exact=True).click()
        expect(page.get_by_text('最终文件内容一致，可以应用。', exact=True)).to_be_visible(timeout=30000)
        page.screenshot(path=str(artifacts / 'history.png'), full_page=True)
        page.get_by_role('button', name='应用到 main', exact=True).click()
        expect(page.locator('.history-columns > section').first.get_by_text('整理接口说明\n\n保留最终文件内容', exact=True)).to_be_visible(timeout=30000)
        expect(page.get_by_role('textbox', name='提交信息 1', exact=True)).to_have_count(0)
        page.reload()
        expect(page.get_by_text('整理接口说明\n\n保留最终文件内容', exact=True)).to_be_visible()

        page.goto(origin + '?surface=rebase')
        expect(page.get_by_text('订单接口', exact=True)).to_be_visible(timeout=30000)
        page.get_by_role('button', name='选择全部', exact=True).click()
        expect(page.get_by_role('checkbox')).to_be_checked()
        page.screenshot(path=str(artifacts / 'rebase.png'), full_page=True)
        page.goto(origin)
        expect(page.get_by_role('heading', name='订单接口', exact=True)).to_be_visible()
        page.set_viewport_size({'width': 360, 'height': 900})
        page.evaluate("document.body.className = 'vscode-dark'")
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.add_style_tag(content=''' :root { --vscode-editor-background:#1f1f1f; --vscode-editor-foreground:#ccc;
          --vscode-button-background:#0078d4; --vscode-button-foreground:white;
          --vscode-input-background:#313131; --vscode-descriptionForeground:#aaa;
          --vscode-textCodeBlock-background:#292929; --vscode-button-secondaryBackground:#313131;
          --vscode-button-secondaryForeground:#ccc; --vscode-widget-border:#555; }''')
        expect(page.get_by_role('textbox', name='提交信息', exact=True)).to_have_css('color', 'rgb(204, 204, 204)')
        page.screenshot(path=str(artifacts / 'task-dark-sidebar.png'), full_page=True, animations='disabled')
        page.add_style_tag(content=':root { --vscode-editor-background:#000; --vscode-editor-foreground:#fff; --vscode-widget-border:#fff; --vscode-focusBorder:#f38518; }')
        page.evaluate("document.body.className = 'vscode-high-contrast'")
        expect(page.get_by_role('textbox', name='提交信息', exact=True)).to_have_css('color', 'rgb(255, 255, 255)')
        page.screenshot(path=str(artifacts / 'task-high-contrast.png'), full_page=True, animations='disabled')
        assert not errors, errors
        assert page.evaluate('window.__hostError') is None
        browser.close()
    print('Webview browser flows passed: branch setup, ACP configuration guide, fresh workspace, multiline notes, scripts, setup, history preview/apply, rebase selection.')
except Exception:
    if 'errors' in globals():
        print('Browser errors:', errors, file=sys.stderr)
    raise
finally:
    host.terminate()
    host.wait(timeout=30)
