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
        for surface in ['task', 'rebase', 'settings']:
            page.goto(origin + '?surface=' + surface)
            expect(page.get_by_role('button', name='Choose Agent Preset' if surface == 'settings' else 'Configure ACP', exact=True)).to_be_visible()
            if surface != 'settings':
                expect(page.locator('main')).to_have_text('Configure ACP')
                expect(page.locator('.acp-setup')).to_have_count(0)
            page.evaluate("async () => { await queue; await new Promise(resolve => requestAnimationFrame(resolve)); }")
            initial = page.request.get(origin + '/model?surface=' + surface).json()
            def blocked():
                expect(page.get_by_role('button', name='Select Base Branch', exact=True)).to_have_count(0)
                expect(page.get_by_role('button', name='Select Repository', exact=True)).to_have_count(0)
                expect(page.get_by_role('region', name='Preview', exact=True)).to_have_count(0)
                expect(page.get_by_role('region', name='Edit Notes', exact=True)).to_have_count(0)
                expect(page.get_by_role('heading', name='Scripts', exact=True)).to_have_count(0)
            blocked()
            expect(page.get_by_role('button')).to_have_count(1)
            invalid = {**initial, 'agentConfiguration': {'status': 'invalid', 'message': 'Agent profiles require a valid label and command.'}}
            page.evaluate("model => window.postMessage({type:'model', model}, '*')", invalid)
            if surface == 'settings':
                expect(page.get_by_role('alert')).to_contain_text('valid label and command')
            else:
                expect(page.locator('main')).to_have_text('Configure ACP')
            blocked()
            for readiness in [
                {'status': 'unchecked'},
                {'status': 'error', 'message': 'Agent executable not found.'},
                {'status': 'authentication_required', 'message': 'Sign in to continue.', 'authMethods': [{'id': 'login', 'name': 'Sign In'}]},
                {'status': 'checking', 'message': 'Connecting to ACP…'},
            ]:
                configured = {**initial, 'agentConfiguration': {'status': 'configured', 'count': 1}, 'agentReadiness': readiness}
                page.evaluate("model => window.postMessage({type:'model', model}, '*')", configured)
                label = 'Configure ACP' if surface != 'settings' else 'Cancel Connection' if readiness['status'] == 'checking' else 'Authenticate Agent' if readiness['status'] == 'authentication_required' else 'Connect ACP'
                expect(page.get_by_role('button', name=label, exact=True)).to_be_visible()
                blocked()
                if surface != 'settings':
                    expect(page.locator('main')).to_have_text('Configure ACP')
                elif readiness['status'] == 'error':
                    expect(page.get_by_role('alert')).to_contain_text('executable not found')
                if surface == 'settings' and readiness['status'] in ['error', 'checking']:
                    page.screenshot(path=str(artifacts / ('connection-' + readiness['status'] + '.png')), full_page=True)
            ready = {**initial, 'agentConfiguration': {'status': 'configured', 'count': 1}, 'agentReadiness': {'status': 'ready'}}
            for repository in ['', initial['repository']]:
                loading = {**ready, 'repository': repository, 'repositoryState': 'loading'}
                page.evaluate("model => window.postMessage({type:'model', model}, '*')", loading)
                expect(page.get_by_role('status')).to_have_text('Opening repository…')
                expect(page.get_by_role('button')).to_have_count(0)
            unselected = {**ready, 'repository': '', 'repositoryState': 'unselected', 'workflow': None}
            page.evaluate("model => window.postMessage({type:'model', model}, '*')", unselected)
            expect(page.get_by_role('button', name='Select Repository', exact=True)).to_be_visible()
            page.evaluate("model => window.postMessage({type:'model', model}, '*')", initial)
            blocked()
        page.goto(origin + '?surface=task')
        expect(page.get_by_role('button', name='Configure ACP', exact=True)).to_be_visible()
        expect(page.get_by_role('button')).to_have_count(1)
        page.get_by_role('button', name='Configure ACP', exact=True).click()
        expect(page.get_by_role('heading', name='ACP', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='Choose Agent Preset', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='Connect ACP', exact=True)).to_have_count(0)
        expect(page.get_by_role('heading', name='Scripts', exact=True)).to_have_count(0)
        assert page.request.get(origin + '/model?surface=settings').json()['agentConfiguration']['status'] == 'missing'
        page.set_viewport_size({'width': 320, 'height': 700})
        page.get_by_text('ACP Setup Guide and Example', exact=True).click()
        expect(page.locator('.acp-setup pre')).to_contain_text('warden.acpAgents')
        expect(page.locator('.acp-setup').get_by_role('link', name='codex-acp adapter', exact=True)).to_be_visible()
        expect(page.locator('.acp-setup').get_by_role('link', name='OpenCode', exact=True)).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.screenshot(path=str(artifacts / 'agent-setup-gate.png'), full_page=True)
        page.get_by_text('ACP Setup Guide and Example', exact=True).click()
        page.set_viewport_size({'width': 1100, 'height': 900})
        page.get_by_role('button', name='Choose Agent Preset', exact=True).click()
        expect(page.get_by_role('button', name='Reconnect ACP', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='Select Base Branch', exact=True)).to_have_count(0)
        assert not page.evaluate("window.__actions.some(action => action.type === 'setup.checkAgent')"), 'configuration connects without a manual check'
        page.goto(origin + '?surface=task')
        expect(page.get_by_role('button', name='Select Base Branch', exact=True)).to_be_visible()
        page.get_by_role('button', name='Select Base Branch', exact=True).click()
        page.goto(origin + '?surface=rebase')
        expect(page.get_by_text('No workspaces', exact=True)).to_be_visible()
        # Native task creation and automatic allocation are covered in the extension host.
        def action(value):
            result = page.request.post(origin + '/action?surface=task', data=value)
            assert result.ok, result.text()
            return result.json()

        model = action({'type': 'task.create', 'title': '订单接口', 'body': '原有说明'})
        first_id = model['task']['id']
        assert model['task']['worktree'], 'New tasks allocate a workspace automatically'
        page.goto(origin + '?surface=task')
        notes = page.get_by_role('region', name='Edit Notes', exact=True)
        expect(notes.get_by_role('textbox', name='Notes', exact=True)).to_have_value('原有说明')
        notes.get_by_role('textbox', name='Notes', exact=True).fill('尚未保存的说明草稿')
        page.reload()
        expect(notes.get_by_role('textbox', name='Notes', exact=True)).to_have_value('尚未保存的说明草稿')
        page.evaluate("async () => { await queue; sessionStorage.removeItem('warden-state'); }")
        page.reload()
        expect(notes.get_by_role('textbox', name='Notes', exact=True)).to_have_value('尚未保存的说明草稿')
        assert page.request.get(origin + '/model?surface=task').json()['task']['body'] == '原有说明'
        branch_a = page.request.get(origin + '/model?surface=task').json()
        unavailable = {**branch_a, 'agentReadiness': {'status': 'error', 'message': 'The agent connection was lost.'}}
        page.evaluate("model => window.postMessage({type:'model', model}, '*')", unavailable)
        expect(page.get_by_role('region', name='Edit Notes', exact=True)).to_have_count(0)
        expect(page.get_by_role('button', name='Configure ACP', exact=True)).to_be_visible()
        page.evaluate("model => window.postMessage({type:'model', model}, '*')", branch_a)
        expect(notes.get_by_role('textbox', name='Notes', exact=True)).to_have_value('尚未保存的说明草稿')
        branch_b = action({'type': 'task.create', 'title': '其他任务', 'body': 'B 原有说明'})
        page.goto(origin + '?surface=task')
        expect(notes.get_by_role('textbox', name='Notes', exact=True)).to_have_value('B 原有说明')
        notes.get_by_role('textbox', name='Notes', exact=True).fill('B 未保存的说明')
        page.evaluate("async () => { await queue; sessionStorage.removeItem('warden-state'); }")
        page.reload()
        expect(notes.get_by_role('textbox', name='Notes', exact=True)).to_have_value('B 未保存的说明')
        action({'type': 'task.select', 'taskId': first_id})
        page.reload()
        expect(notes.get_by_role('textbox', name='Notes', exact=True)).to_have_value('尚未保存的说明草稿')
        notes.get_by_role('textbox', name='Notes', exact=True).fill('  保存后的订单说明  \n')
        notes.get_by_role('button', name='Save Notes', exact=True).click()
        expect(notes.get_by_role('status')).to_have_text('Saved')
        page.reload()
        expect(notes.get_by_role('textbox', name='Notes', exact=True)).to_have_value('保存后的订单说明')
        assert page.request.get(origin + '/model?surface=task').json()['task']['body'] == '保存后的订单说明'
        notes.get_by_role('textbox', name='Notes', exact=True).fill('应当丢弃的草稿')
        notes.get_by_role('button', name='Discard Changes', exact=True).click()
        page.evaluate("async () => { await queue; sessionStorage.removeItem('warden-state'); }")
        action({'type': 'task.update', 'taskId': first_id, 'title': '订单接口', 'body': '外部更新说明'})
        page.reload()
        expect(notes.get_by_role('textbox', name='Notes', exact=True)).to_have_value('外部更新说明')
        action({'type': 'task.update', 'taskId': first_id, 'title': '订单接口', 'body': '保存后的订单说明'})
        page.reload()
        expect(notes.get_by_role('textbox', name='Notes', exact=True)).to_have_value('保存后的订单说明')

        page.set_viewport_size({'width': 320, 'height': 700})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.screenshot(path=str(artifacts / 'task-notes.png'), full_page=True)
        page.set_viewport_size({'width': 1100, 'height': 900})

        page.goto(origin + '?surface=settings')
        expect(page.get_by_role('heading', name='ACP', exact=True)).to_be_visible()
        expect(page.locator('.acp-setup pre')).not_to_be_visible()
        page.get_by_text('ACP Setup Guide and Example', exact=True).click()
        expect(page.locator('.acp-setup pre')).to_contain_text('warden.acpAgents')
        page.get_by_role('button', name='Choose Agent Preset', exact=True).click()
        page.wait_for_function("window.__actions.some(action => action.type === 'settings.agents')")
        page.screenshot(path=str(artifacts / 'settings-acp.png'), full_page=True)
        page.get_by_text('ACP Setup Guide and Example', exact=True).click()
        page.get_by_role('textbox', name='Workspace Setup Script', exact=True).fill('echo workspace-ready')
        page.get_by_role('textbox', name='Preview Setup Script', exact=True).fill('echo preview-ready')
        page.get_by_role('button', name='Save Script Configuration', exact=True).click()
        page.wait_for_function('window.__settingsSaved === true')
        page.reload()
        expect(page.get_by_role('textbox', name='Preview Setup Script', exact=True)).to_have_value('echo preview-ready')

        page.goto(origin + '?surface=rebase')
        expect(page.get_by_text('订单接口', exact=True)).to_be_visible(timeout=30000)
        expect(page.locator('label').filter(has_text='订单接口').get_by_text('Blocked', exact=True)).to_be_visible()
        page.get_by_role('checkbox', name='Select All', exact=True).check()
        expect(page.get_by_role('checkbox', name='订单接口', exact=True)).to_be_checked()
        page.screenshot(path=str(artifacts / 'rebase.png'), full_page=True)

        # A check forecast must remain distinct from a preview conflict or a failed execution.
        forecast = page.request.get(origin + '/model?surface=rebase').json()
        forecast['checks']['checks'][0].update(status='current', message='Includes the current base branch commit.')
        page.evaluate("model => window.postMessage({type:'model', model}, '*')", forecast)
        expect(page.get_by_text('Up to Date', exact=True)).to_be_visible()
        forecast['checks']['checks'][0].update(status='conflict', message='Conflicts expected in src/orders.ts. Rebase has not run.')
        page.evaluate("model => window.postMessage({type:'model', model}, '*')", forecast)
        expect(page.get_by_text('Conflicts Expected', exact=True)).to_be_visible()
        expect(page.get_by_text('Preview Conflict', exact=True)).to_have_count(0)
        expect(page.get_by_role('heading', name='Results', exact=True)).to_have_count(0)
        page.screenshot(path=str(artifacts / 'rebase-forecast.png'), full_page=True)

        second = action({'type': 'task.create', 'title': '表单校验', 'body': ''})['task']
        assert second['worktree'] != model['task']['worktree']
        page.goto(origin + '?surface=rebase')
        select_all = page.get_by_role('checkbox', name='Select All', exact=True)
        page.get_by_role('checkbox', name='订单接口', exact=True).check()
        expect(select_all).to_have_attribute('aria-checked', 'mixed')
        select_all.check()
        expect(page.get_by_role('checkbox', name='表单校验', exact=True)).to_be_checked()
        select_all.uncheck()
        expect(page.get_by_role('checkbox', name='订单接口', exact=True)).not_to_be_checked()
        expect(page.get_by_role('checkbox', name='表单校验', exact=True)).not_to_be_checked()
        expect(page.get_by_role('button', name='Rebase Selected', exact=True)).to_be_disabled()
        action({'type': 'task.select', 'taskId': first_id})
        for theme in ['dark', 'contrast']:
            page.goto(origin + '?surface=task&theme=' + theme)
            page.set_viewport_size({'width': 360, 'height': 900})
            expect(notes.get_by_role('textbox', name='Notes', exact=True)).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            page.screenshot(path=str(artifacts / ('task-notes-' + theme + '.png')), full_page=True, animations='disabled')
        assert not errors, errors
        assert page.evaluate('window.__hostError') is None
        browser.close()
    print('Webview browser flows passed: agent setup before branch selection, task-note editing and drafts, light/dark/high-contrast layouts, script settings and rebase. Native navigation and preview controls are verified in the packaged extension host.')
except Exception:
    if 'errors' in globals():
        print('Browser errors:', errors, file=sys.stderr)
    raise
finally:
    host.terminate()
    host.wait(timeout=30)
