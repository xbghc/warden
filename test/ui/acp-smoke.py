"""Exercise packaged ACP conversation controls with real stdio agents and task workspaces."""
import json
import os
from pathlib import Path
import subprocess
from time import monotonic
from playwright.sync_api import sync_playwright, expect

artifacts = Path(os.environ.get('WARDEN_UI_ARTIFACTS', '/tmp/warden-ui-artifacts'))
artifacts.mkdir(parents=True, exist_ok=True)
host = subprocess.Popen(['node', '--import', 'tsx', 'test/ui/acp-harness.ts'], stdout=subprocess.PIPE, text=True)
try:
    info = json.loads(host.stdout.readline())
    origin = f"http://127.0.0.1:{info['port']}"
    with sync_playwright() as playwright:
        executable = os.environ.get('CHROMIUM_PATH') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
        browser = playwright.chromium.launch(executable_path=executable, headless=True, args=['--no-sandbox'])
        first = browser.new_page(viewport={'width': 1000, 'height': 900})
        second = browser.new_page(viewport={'width': 1000, 'height': 900})
        errors = []
        for page in [first, second]:
            page.on('pageerror', lambda error: errors.append(str(error)))

        def inspect():
            return first.request.get(origin + '/inspect').json()

        def send(page, text):
            page.get_by_role('textbox', name='Message', exact=True).fill(text)
            page.get_by_role('button', name='Send', exact=True).click()

        def chat_action(page, name):
            page.get_by_role('button', name='More Chat Actions', exact=True).click()
            page.get_by_role('menuitem', name=name, exact=True).click()

        def new_session(page):
            chat_action(page, 'New Session')

        def use_agent(page, profile):
            task = page.evaluate("new URL(location.href).searchParams.get('task') || '0'")
            assert page.request.post(origin + '/default-profile?task=' + task + '&profile=' + profile).ok
            page.wait_for_function('profile => window.__model.defaultProfileId === profile', arg=profile)

        def connected(page):
            page.wait_for_function("window.__model?.status === 'connected' && !window.__model.sending")

        def wait_host(page, route, predicate):
            # Poll resolved host state: wait_for_function treats an async predicate's
            # Promise as truthy before its eventual boolean result is available.
            task = page.evaluate("new URL(location.href).searchParams.get('task') || '0'")
            deadline = monotonic() + 30
            while monotonic() < deadline:
                state = page.request.get(origin + route + '?task=' + task).json()
                if predicate(state):
                    return state
                page.wait_for_timeout(25)
            raise AssertionError({'route': route, 'lastState': state})

        def saved_draft(page, text):
            wait_host(page, '/model', lambda model: model['draft'] == text)

        def conversation(messages):
            # Agents may replay adjacent same-role messages with different chunk boundaries.
            merged = []
            for item in messages:
                if item['role'] not in ['user', 'agent']:
                    continue
                if merged and merged[-1][0] == item['role']:
                    merged[-1][1] += item['text']
                else:
                    merged.append([item['role'], item['text']])
            return merged

        first.goto(origin + '?task=0')
        second.goto(origin + '?task=1')
        expect(first.get_by_role('heading', name='订单筛选参数', exact=True)).to_be_visible()
        expect(second.get_by_role('heading', name='分页默认值', exact=True)).to_be_visible()
        connected(first)
        connected(second)
        expect(first.get_by_role('region', name='Agent Authentication')).to_have_count(0)
        expect(first.get_by_role('textbox', name='Message', exact=True)).to_have_value('')
        first.get_by_role('button', name='Use Task Brief', exact=True).click()
        first.wait_for_function("window.__model.draft.includes('订单筛选参数')")
        expect(first.get_by_role('textbox', name='Message', exact=True)).to_be_focused()
        for entry in inspect()['entries']:
            journal = [json.loads(line) for line in entry['journals'][0].splitlines()]
            assert sum(row.get('method') == 'session/new' for row in journal) == 1
            assert not any(row.get('method') == 'session/prompt' for row in journal)
        expect(first.get_by_role('button', name='Resume Session', exact=True)).to_have_count(0)
        expect(first.get_by_role('button', name='Connect Agent', exact=True)).to_have_count(0)
        review = first.get_by_role('button', name='View Task Diff', exact=True)
        review.focus()
        expect(first.get_by_role('tooltip', name='View Task Diff', exact=True)).to_be_visible()
        review.press('Escape')
        review.click()
        first.wait_for_function("window.__actions.some(message => message.action?.type === 'review')")

        # Capturing a view flushes a debounced edit before the host changes its routing token.
        composer = first.get_by_role('textbox', name='Message', exact=True)
        composer.fill('Draft before moving the chat')
        first.evaluate("window.dispatchEvent(new MessageEvent('message', {data: {type: 'acp-capture', panelId: window.__model.panelId, requestId: 'move-check'}}))")
        first.wait_for_function("window.__actions.some(message => message.action?.type === 'view-state' && message.action.requestId === 'move-check')")
        saved_draft(first, 'Draft before moving the chat')
        expect(composer).to_be_disabled()
        assert first.request.post(origin + '/reopen?task=0').ok
        first.reload()
        expect(composer).to_have_value('Draft before moving the chat')
        expect(composer).to_be_enabled()
        first.evaluate("async () => { await window.__fixture.pauseModels(); window.__fixture.deliver({ ...window.__model, presentation: 'editor' }); }")
        first.get_by_role('button', name='Move Chat to Side Bar', exact=True).click()
        first.wait_for_function("window.__actions.some(message => message.action?.type === 'open-sidebar')")
        first.evaluate('window.__fixture.resumeModels()')
        first.set_viewport_size({'width': 320, 'height': 740})
        for theme in ['light', 'dark', 'high-contrast']:
            first.evaluate("""theme => {
                document.body.className = 'vscode-' + theme;
                const dark = theme !== 'light', contrast = theme === 'high-contrast';
                const colors = {
                    'sideBar-background': contrast ? '#000' : dark ? '#181818' : '#f3f3f3',
                    'editor-background': dark ? '#181818' : '#fff',
                    'editor-foreground': dark ? '#eee' : '#222',
                    'descriptionForeground': dark ? '#bdbdbd' : '#686868',
                    'textCodeBlock-background': dark ? '#252525' : '#f4f4f4',
                    'button-secondaryBackground': dark ? '#333' : '#e9e9e9',
                    'button-secondaryForeground': dark ? '#eee' : '#333',
                    'widget-border': contrast ? '#fff' : dark ? '#555' : '#bbb',
                    'input-border': contrast ? '#fff' : '#888',
                    'focusBorder': contrast ? '#f38518' : '#007acc',
                };
                for (const [key, value] of Object.entries(colors)) document.documentElement.style.setProperty('--vscode-' + key, value);
            }""", theme)
            assert first.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'sidebar must not overflow horizontally'
            rect = composer.bounding_box()
            assert rect['y'] + rect['height'] <= 740, 'composer stays visible in the sidebar'
            expect(composer).to_have_css('color', 'rgb(34, 34, 34)' if theme == 'light' else 'rgb(238, 238, 238)')
            first.screenshot(path=str(artifacts / ('acp-sidebar-' + theme + '.png')), full_page=True)
        first.evaluate("async () => { await window.__fixture.pauseModels(); window.__fixture.deliver({ ...window.__model, error: 'Check the agent connection and try again.' }); }")
        expect(first.get_by_role('alert')).to_be_in_viewport()
        expect(composer).to_be_in_viewport()
        first.screenshot(path=str(artifacts / 'acp-sidebar-error.png'), full_page=True)
        first.evaluate('window.__fixture.resumeModels()')
        first.evaluate("document.documentElement.removeAttribute('style'); document.body.className = ''")
        first.set_viewport_size({'width': 1000, 'height': 900})

        first.evaluate("async () => { await window.__fixture.pauseModels(); window.__fixture.deliver({ ...window.__model, profiles: [] }); }")
        expect(first.get_by_role('button', name='Send', exact=True)).to_be_disabled()
        expect(first.locator('.acp-setup')).to_have_count(0)
        expect(first.get_by_role('combobox', name='Agent Profile', exact=True)).to_have_count(0)
        expect(first.get_by_role('button', name='Configure Agent', exact=True)).to_have_count(0)
        expect(first.get_by_text('Check the agent connection in the Warden workbench to continue.', exact=True)).to_be_visible()
        assert not any(item['role'] == 'user' for entry in inspect()['entries'] for item in entry['model']['record']['messages'])
        first.screenshot(path=str(artifacts / 'acp-unavailable.png'), full_page=True)
        first.evaluate("() => window.__fixture.resumeModels()")

        send(first, 'own-edit')
        expect(first.locator('.acp-message-agent')).to_contain_text('Edited')
        connected(first)
        expect(first.get_by_role('textbox', name='Message', exact=True)).to_have_value('')
        state = inspect()
        assert state['entries'][0]['output'].startswith('task 1 edited by ')
        assert state['entries'][1]['output'] is None
        assert state['primaryStatus'] == ''
        assert state['primaryContext'] == state['previewContext'] == 'primary baseline\n'

        send(first, 'terminal-output')
        connected(first)
        failed_tool = first.locator('.acp-message-tool').filter(has_text='Check failed')
        expect(failed_tool.locator('summary')).to_contain_text('Exit 7')
        expect(first.locator('.acp-message-tool').filter(has_text='Inspect a diff').locator('summary')).to_contain_text('Failed')
        expect(first.locator('.acp-message-tool').filter(has_text='Inspect a diff').locator('summary')).to_contain_text('Exit 1')
        expect(first.locator('.acp-message-tool').filter(has_text='Inspect a diff')).not_to_contain_text('this terminal is not managed by Warden')
        expect(first.locator('.acp-message-tool').filter(has_text='Read literal output').locator('summary')).not_to_contain_text('Exit 99')
        failed_tool.locator('summary').click()
        expect(failed_tool.locator('pre')).to_contain_text('first line\nfailure detail')
        expect(failed_tool.locator('pre')).to_contain_text('Exit code: 7')
        expect(failed_tool.locator('pre')).not_to_contain_text('wrong terminal')
        first.screenshot(path=str(artifacts / 'acp-command-output.png'), full_page=True)

        send(first, 'terminal-hold')
        unfinished = first.locator('.acp-message-tool').filter(has_text='Long command')
        expect(unfinished.locator('summary')).to_contain_text('Running')
        first.get_by_role('button', name='Stop Turn', exact=True).click()
        connected(first)
        expect(unfinished.locator('summary')).to_contain_text('Outcome Unknown')
        expect(unfinished.locator('.acp-spinner')).to_have_count(0)
        unfinished.locator('summary').click()
        expect(unfinished).to_contain_text('Its command may still be running.')
        expect(unfinished.locator('pre')).to_contain_text('Output before cancellation')
        first.screenshot(path=str(artifacts / 'acp-cancelled-tool.png'), full_page=True)
        first.reload()
        connected(first)
        expect(unfinished.locator('summary')).to_contain_text('Outcome Unknown')

        composer = first.get_by_role('textbox', name='Message', exact=True)
        composer.fill('First line')
        composer.press('End')
        composer.press('Shift+Enter')
        composer.press('x')
        expect(composer).to_have_value('First line\nx')
        prompts_before = len([item for item in inspect()['entries'][0]['model']['record']['messages'] if item['role'] == 'user'])
        composer.evaluate("element => element.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', isComposing: true, bubbles: true}))")
        composer.evaluate("element => element.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', keyCode: 229, bubbles: true}))")
        saved_draft(first, 'First line\nx')
        assert len([item for item in inspect()['entries'][0]['model']['record']['messages'] if item['role'] == 'user']) == prompts_before
        composer.press('Enter')
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_have_text('Echo: First line\nx')
        connected(first)
        expect(composer).to_have_value('')
        # Completion is not available for another send until its final storage
        # save and host draft bookkeeping finish, including after panel reload.
        assert first.request.post(origin + '/completion?task=0').ok
        send(first, 'held completion')
        wait_host(first, '/completion', lambda state: state['blocked'])
        first.wait_for_function("window.__model.sending && window.__model.status === 'running'")
        expect(first.locator('.acp-composer button[type="submit"]')).to_have_count(0)
        first.reload()
        first.wait_for_function("window.__model.sending && window.__model.status === 'running'")
        expect(composer).to_have_value('')
        expect(first.locator('.acp-composer button[type="submit"]')).to_have_count(0)
        composer.fill('follow-up during completion')
        saved_draft(first, 'follow-up during completion')
        expect(first.locator('.acp-composer button[type="submit"]')).to_have_count(0)
        assert first.request.get(origin + '/completion?task=0').json()['blocked']
        assert first.request.delete(origin + '/completion?task=0').ok
        connected(first)
        expect(composer).to_have_value('follow-up during completion')
        expect(first.get_by_role('button', name='Send', exact=True)).to_be_enabled()
        first.get_by_role('button', name='Send', exact=True).click()
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_have_text('Echo: follow-up during completion')
        connected(first)
        expect(composer).to_have_value('')
        completion_state = inspect()['entries'][0]
        assert not completion_state['model'].get('error'), completion_state['model']
        completion_prompts = [json.loads(line) for line in completion_state['journals'][0].splitlines() if json.loads(line).get('method') == 'session/prompt']
        assert sum(any(part.get('text') == 'follow-up during completion' for part in item['params']['prompt']) for item in completion_prompts) == 1

        # Deliver two explicit sends from the same panel version while suppressing
        # model acknowledgements. Only completion clears separate their revisions.
        first.evaluate('window.__fixture.pauseModels()')
        before_clear = first.request.get(origin + '/model?task=0').json()
        for offset, text in enumerate(['unacknowledged completion', 'rapid next draft'], start=1):
            response = first.request.post(origin + '/action?task=0', data={
                'panelId': before_clear['panelId'],
                'action': {'type': 'send', 'text': text, 'profileId': 'normal',
                           'version': before_clear['draftVersion'], 'revision': before_clear['draftRevision'] + offset},
            })
            assert response.ok
            def completed_prompt(model):
                assert not model.get('error'), model
                return not model['sending'] and model['status'] == 'connected' and any(
                    item['role'] == 'user' and item['text'] == text and item.get('uncertain') is False
                    for item in model['record']['messages']
                )
            wait_host(first, '/model', completed_prompt)
        stale_clear_state = first.request.get(origin + '/model?task=0').json()
        assert stale_clear_state['draftVersion'] == before_clear['draftVersion'] + 2
        assert len([item for item in stale_clear_state['record']['messages'] if item['role'] == 'user' and item['text'] == 'rapid next draft']) == 1
        first.evaluate('window.__fixture.resumeModels()')
        expect(composer).to_have_value('')

        # Saving a draft need not echo it before the host appends an editor selection.
        # Batch the reveal and append models, as VS Code can do before React renders.
        first.evaluate('window.__fixture.pauseModels()')
        composer.fill('审阅这段实现')
        saved_draft(first, '审阅这段实现')
        first.evaluate("window.__fixture.append('选区内容：const page = 1;')")
        combined = '审阅这段实现\n\n选区内容：const page = 1;'
        expect(composer).to_have_value(combined)
        first.evaluate('window.__fixture.resumeModels()')
        saved_draft(first, combined)
        first.get_by_role('button', name='Send', exact=True).click()
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_have_text('Echo: ' + combined)
        expect(composer).to_have_value('')

        # Hold an already posted edit across the host append. Its late arrival must
        # neither remove the excerpt nor replace the user's more recent wording.
        first.evaluate('window.__fixture.pauseModels()')
        first.evaluate('window.__fixture.holdDrafts()')
        old_model = first.evaluate('window.__model')
        composer.fill('仍在输入的补充说明')
        first.wait_for_function("window.__actions.at(-1)?.action?.type === 'draft' && window.__actions.at(-1).action.text === '仍在输入的补充说明'")
        assert inspect()['entries'][0]['model']['draft'] == ''
        first.evaluate("window.__fixture.append('选区内容：const limit = 20;')")
        pending_combined = '仍在输入的补充说明\n\n选区内容：const limit = 20;'
        expect(composer).to_have_value(pending_combined)
        first.evaluate('window.__fixture.releaseDrafts()')
        saved_draft(first, pending_combined)
        first.evaluate('model => window.__fixture.deliver(model)', old_model)
        expect(composer).to_have_value(pending_combined)
        first.evaluate('window.__fixture.resumeModels()')
        expect(composer).to_have_value(pending_combined)
        first.get_by_role('button', name='Send', exact=True).click()
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_have_text('Echo: ' + pending_combined)
        expect(composer).to_have_value('')

        # A click from a model older than an append must not silently omit context.
        composer.fill('发送前的说明')
        first.wait_for_function("window.__model.draft === '发送前的说明'")
        first.evaluate('window.__fixture.pauseModels()')
        users_before = len([item for item in inspect()['entries'][0]['model']['record']['messages'] if item['role'] == 'user'])
        first.evaluate("window.__fixture.append('选区内容：const offset = 0;', false)")
        first.get_by_role('button', name='Send', exact=True).click()
        wait_host(first, '/model', lambda model: model.get('error'))
        first.evaluate('window.__fixture.resumeModels()')
        stale_combined = '发送前的说明\n\n选区内容：const offset = 0;'
        expect(composer).to_have_value(stale_combined)
        users_after = len([item for item in inspect()['entries'][0]['model']['record']['messages'] if item['role'] == 'user'])
        assert users_after == users_before, 'a stale send must not reach the agent without the appended selection'
        first.get_by_role('button', name='Send', exact=True).click()
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_have_text('Echo: ' + stale_combined)
        expect(composer).to_have_value('')

        # A new transcript may arrive while its unchanged composer has newer local
        # edits. Hold both the model and outgoing edit to make the overlap explicit.
        connected(first)
        previous_record = first.evaluate('window.__model.record.id')
        first.evaluate('window.__fixture.pauseModels()')
        first.evaluate('window.__fixture.holdDrafts()')
        new_session(first)
        wait_host(first, '/model', lambda model: model['record']['id'] != previous_record)
        composer.fill('新会话建立时输入的说明')
        newer_record = first.request.get(origin + '/model?task=0').json()
        first.evaluate('model => window.__fixture.deliver(model)', newer_record)
        expect(composer).to_have_value('新会话建立时输入的说明')
        first.evaluate('window.__fixture.releaseDrafts()')
        first.evaluate('window.__fixture.resumeModels()')
        saved_draft(first, '新会话建立时输入的说明')
        first.get_by_role('button', name='Send', exact=True).click()
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_have_text('Echo: 新会话建立时输入的说明')
        expect(composer).to_have_value('')

        send(first, 'hold')
        expect(first.get_by_role('button', name='Stop Turn', exact=True)).to_be_enabled()
        first.get_by_role('textbox', name='Message', exact=True).fill('稍后继续补充分页参数')
        first.wait_for_function("window.__model.draft === '稍后继续补充分页参数'")
        send(second, 'second task')
        expect(second.locator('.acp-message-agent')).to_contain_text('Echo: second task')
        first.get_by_role('button', name='Stop Turn', exact=True).click()
        connected(first)
        expect(first.get_by_role('textbox', name='Message', exact=True)).to_have_value('稍后继续补充分页参数')
        expect(first.get_by_text('The previous turn was interrupted', exact=False)).to_have_count(0)

        send(first, 'hold')
        expect(first.get_by_role('button', name='Stop Turn', exact=True)).to_be_enabled()
        saved_drafts = first.evaluate("window.__actions.filter(item => item.action?.type === 'draft').length")
        first.get_by_role('textbox', name='Message', exact=True).fill('')
        first.get_by_role('textbox', name='Message', exact=True).fill('hold')
        first.wait_for_function("count => window.__actions.filter(item => item.action?.type === 'draft').length > count", arg=saved_drafts)
        first.get_by_role('button', name='Stop Turn', exact=True).click()
        connected(first)
        expect(first.get_by_role('textbox', name='Message', exact=True)).to_have_value('hold')
        first.reload()
        expect(first.get_by_role('textbox', name='Message', exact=True)).to_have_value('hold')

        send(first, 'permission')
        expect(first.get_by_role('button', name='Allow this write', exact=True)).to_be_visible()
        expect(first.get_by_text('Outcome Unknown', exact=True)).to_have_count(0)
        expect(composer).to_have_value('')
        first.screenshot(path=str(artifacts / 'acp-permission.png'), full_page=True)
        first.set_viewport_size({'width': 320, 'height': 740})
        expect(first.get_by_role('button', name='Allow this write', exact=True)).to_be_in_viewport()
        expect(first.get_by_role('button', name='Stop Turn', exact=True)).to_be_in_viewport()
        assert first.evaluate('document.documentElement.scrollWidth <= innerWidth')
        first.screenshot(path=str(artifacts / 'acp-sidebar-permission.png'), full_page=True)
        first.set_viewport_size({'width': 280, 'height': 520})
        expect(first.get_by_role('button', name='Allow this write', exact=True)).to_be_in_viewport()
        expect(first.get_by_role('button', name='Stop Turn', exact=True)).to_be_in_viewport()
        expect(first.get_by_label('Session Configuration', exact=True)).not_to_be_visible()
        assert first.evaluate('document.documentElement.scrollWidth <= innerWidth')
        first.screenshot(path=str(artifacts / 'acp-short-permission.png'), full_page=True)
        first.set_viewport_size({'width': 1000, 'height': 900})
        # This agent can expose no selectors; an empty container has no visible box.
        expect(first.get_by_label('Session Configuration', exact=True)).not_to_have_css('display', 'none')

        expect(second.get_by_role('button', name='Allow this write', exact=True)).to_have_count(0)
        # Reopening the panel loses local pending-send state, but a completed turn
        # must still clear its submitted draft through the host's acknowledgement.
        first.reload()
        expect(composer).to_have_value('')
        # Closing and creating a panel also resets its edit revisions and routing ID.
        assert first.request.post(origin + '/reopen?task=0').ok
        first.reload()
        expect(composer).to_have_value('')
        first.get_by_role('button', name='Allow this write', exact=True).click()
        connected(first)
        assert inspect()['entries'][0]['output'] == 'Permission granted\n'
        expect(composer).to_have_value('')
        expect(first.get_by_role('button', name='Send', exact=True)).to_be_disabled()
        first.screenshot(path=str(artifacts / 'acp-reopened-completed-turn.png'), full_page=True)

        send(first, 'permission')
        expect(first.get_by_role('button', name='Allow this write', exact=True)).to_be_visible()
        first.get_by_role('button', name='Stop Turn', exact=True).click()
        connected(first)
        expect(first.get_by_role('button', name='Allow this write', exact=True)).to_have_count(0)

        send(first, 'permission-long')
        permissions = first.get_by_role('region', name='Pending Permissions')
        expect(permissions.get_by_role('button')).to_have_count(3)
        for width, height in [(340, 760), (320, 740), (280, 520)]:
            first.set_viewport_size({'width': width, 'height': height})
            assert permissions.evaluate('(element) => element.scrollWidth <= element.clientWidth'), 'permission choices must not overflow horizontally'
            for button in permissions.get_by_role('button').all():
                expect(button).to_be_in_viewport(ratio=1)
                assert button.evaluate('(element) => element.scrollWidth <= element.clientWidth'), 'complete approval labels must wrap inside their buttons'
            expect(first.get_by_role('button', name='Stop Turn', exact=True)).to_be_in_viewport()
            first.screenshot(path=str(artifacts / f'acp-long-permission-{width}.png'), full_page=True)
        first.get_by_role('button', name='Allow this write', exact=True).click()
        connected(first)
        first.set_viewport_size({'width': 1000, 'height': 900})

        unsafe = '<img src="https://invalid.example/agent-image" onerror="alert(1)"> [command](command:workbench.action.closeWindow)'
        send(first, unsafe)
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_contain_text('command')
        assert first.locator('.acp-transcript img, .acp-transcript a').count() == 0

        send(first, 'permission-command')
        expect(first.get_by_label('Requested Command', exact=True)).to_have_text('printf "first line\\n"\nprintf "second line\\n"')
        expect(first.get_by_text('Decoded JSON preview. Original request in Details and Workspace.', exact=True)).to_be_visible()
        raw_details = first.locator('.acp-permission-details')
        raw_details.locator('summary').click()
        expect(raw_details.locator('pre')).to_contain_text('\\\\n')
        expect(first.get_by_text('Write a disposable test marker', exact=True)).to_be_visible()
        expect(first.get_by_text('Working directory:', exact=False)).to_be_visible()
        first.screenshot(path=str(artifacts / 'acp-readable-command.png'), full_page=True)
        first.set_viewport_size({'width': 280, 'height': 520})
        assert first.get_by_role('region', name='Pending Permissions').evaluate('(element) => element.scrollWidth <= element.clientWidth')
        first.get_by_role('button', name='Reject this write', exact=True).scroll_into_view_if_needed()
        expect(first.get_by_role('button', name='Stop Turn', exact=True)).to_be_in_viewport()
        first.screenshot(path=str(artifacts / 'acp-readable-command-narrow.png'), full_page=True)
        first.get_by_role('button', name='Reject this write', exact=True).click()
        connected(first)
        first.set_viewport_size({'width': 1000, 'height': 900})

        send(first, '[Review output](agent-output.txt:1)')
        file_link = first.locator('.acp-message-agent').last.get_by_role('button', name='Review output', exact=True)
        file_link.click()
        first.wait_for_function("window.__actions.some(message => message.action?.type === 'open-file' && message.action.reference === 'agent-output.txt:1')")

        send(first, 'activity-batch')
        connected(first)
        activity = first.locator('.acp-activity-group').last
        expect(activity.locator('summary').first).to_have_text('4 earlier activities')
        expect(activity.locator('.acp-tool-title').filter(has_text='Completed activity 1')).not_to_be_visible()
        expect(first.locator('.acp-tool-title').filter(has_text='Visible failed check')).to_be_visible()
        expect(first.get_by_text('Activity summary is still visible', exact=True)).to_be_visible()
        activity.locator('summary').first.click()
        expect(activity.locator('.acp-tool-title').filter(has_text='Completed activity 1')).to_be_visible()
        first.screenshot(path=str(artifacts / 'acp-grouped-activity.png'), full_page=True)

        # Switching views restores the reading position instead of jumping to new output.
        first.set_viewport_size({'width': 320, 'height': 740})
        history = first.get_by_role('log', name='Conversation History')
        history.evaluate('element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); }')
        first.evaluate("window.dispatchEvent(new MessageEvent('message', {data: {type: 'acp-capture', panelId: window.__model.panelId, requestId: 'reading-position'}}))")
        wait_host(first, '/model', lambda model: model.get('viewState', {}).get('followOutput') is False)
        old_panel = first.evaluate('window.__model.panelId')
        assert first.request.post(origin + '/reopen?task=0').ok
        first.reload()
        expect(composer).to_be_enabled()
        first.wait_for_function('document.querySelector(".acp-transcript")?.scrollTop === 0')
        first.evaluate("panelId => window.dispatchEvent(new MessageEvent('message', {data: {type: 'acp-capture', panelId, requestId: 'stale-view'}}))", old_panel)
        expect(composer).to_be_enabled()
        first.screenshot(path=str(artifacts / 'acp-sidebar-history.png'), full_page=True)
        first.set_viewport_size({'width': 1000, 'height': 900})


        chat_action(first, 'Disconnect')
        first.wait_for_function("window.__model.status === 'disconnected'")
        history = conversation(inspect()['entries'][0]['model']['record']['messages'])
        first.reload()
        connected(first)
        restored = conversation(inspect()['entries'][0]['model']['record']['messages'])
        assert restored == history, {'before': history, 'after': restored}

        send(first, 'crash')
        first.wait_for_function("window.__model.status === 'error'")
        expect(first.get_by_role('region', name='Agent Authentication')).to_have_count(0)
        expect(first.get_by_role('button', name='Reconnect', exact=True)).to_be_enabled()
        expect(first.get_by_role('textbox', name='Message', exact=True)).to_have_value('crash')
        expect(first.get_by_text('The previous turn was interrupted', exact=False)).to_be_visible()
        first.get_by_text('Error Details', exact=True).click()
        expect(first.get_by_role('button', name='Copy Error', exact=True)).to_be_visible()
        first.get_by_role('button', name='Reconnect', exact=True).click()
        connected(first)
        expect(first.get_by_role('textbox', name='Message', exact=True)).to_have_value('crash')
        journal = inspect()['entries'][0]['journals'][0]
        prompts = [json.loads(line) for line in journal.splitlines() if json.loads(line).get('method') == 'session/prompt']
        assert sum(any(part.get('text') == 'crash' for part in item['params']['prompt']) for item in prompts) == 1

        use_agent(second, 'no-load')
        new_session(second)
        second.wait_for_function("window.__model.status === 'connected' && window.__model.record.profileId === 'no-load'")
        send(second, 'no-load turn')
        expect(second.locator('.acp-message-agent')).to_contain_text('Echo: no-load turn')
        chat_action(second, 'Disconnect')
        second.wait_for_function("window.__model.status === 'disconnected'")
        expect(second.get_by_role('button', name='Reconnect', exact=True)).to_be_disabled()
        expect(second.get_by_text('This agent does not advertise session restoration', exact=False)).to_be_visible()
        unsupported_session = second.evaluate('window.__model.record.sessionId')
        second.reload()
        second.wait_for_function("window.__model.status === 'error'")
        expect(second.get_by_role('alert')).to_contain_text('cannot resume sessions')
        assert second.evaluate('window.__model.record.sessionId') == unsupported_session
        expect(second.locator('.acp-message-agent')).to_contain_text('Echo: no-load turn')

        use_agent(second, 'auth')
        second.request.post(origin + '/reset-release?task=1')
        try:
            new_session(second)
            second.wait_for_function("!window.__model.record.sessionId && window.__model.status === 'resetting'")
            expect(second.get_by_text('Starting New Session', exact=True)).to_be_visible()
            expect(second.get_by_role('button', name='Reconnect', exact=True)).to_be_disabled()
            expect(second.get_by_role('combobox', name='Agent Profile', exact=True)).to_have_count(0)
            second.screenshot(path=str(artifacts / 'acp-resetting.png'), full_page=True)
        finally:
            second.request.delete(origin + '/reset-release?task=1')
        expect(second.get_by_role('button', name='Fixture login', exact=True)).to_be_visible()
        expect(second.get_by_role('button', name='External login', exact=True)).to_have_count(0)
        second.get_by_role('button', name='Fixture login', exact=True).click()
        connected(second)
        expect(second.get_by_role('button', name='Fixture login', exact=True)).to_have_count(0)

        use_agent(second, 'auth-external')
        new_session(second)
        expect(second.get_by_role('button', name='I Have Signed In — Reconnect', exact=True)).to_be_visible()
        external_record = second.evaluate('window.__model.record.id')
        second.get_by_role('textbox', name='Message', exact=True).fill('Keep this draft after external login')
        saved_draft(second, 'Keep this draft after external login')
        assert second.request.post(origin + '/external-login?task=1').ok
        second.get_by_role('button', name='I Have Signed In — Reconnect', exact=True).click()
        connected(second)
        assert second.evaluate('window.__model.record.id') == external_record
        expect(second.get_by_role('textbox', name='Message', exact=True)).to_have_value('Keep this draft after external login')
        expect(second.get_by_role('region', name='Agent Authentication')).to_have_count(0)
        external_requests = [json.loads(line) for line in inspect()['entries'][1]['journals'][6].splitlines()]
        assert not any(row.get('method') in ['authenticate', 'session/prompt'] for row in external_requests)

        use_agent(second, 'incompatible')
        new_session(second)
        second.wait_for_function("window.__model.status === 'error'")
        second.get_by_role('button', name='More Chat Actions', exact=True).click()
        expect(second.get_by_role('menuitem', name='New Session', exact=True)).to_be_enabled()
        second.get_by_role('menuitem', name='New Session', exact=True).press('Escape')
        chat_action(second, 'End Agent Process')
        second.wait_for_function("window.__model.status === 'disconnected'")
        expect(second.get_by_role('combobox', name='Agent Profile', exact=True)).to_have_count(0)
        use_agent(second, 'normal')
        new_session(second)
        connected(second)

        use_agent(first, 'controls-composer')
        new_session(first)
        connected(first)
        model_selector = first.get_by_role('combobox', name='模型', exact=True)
        thinking = first.get_by_role('checkbox', name='显示思考', exact=True)
        effort_selector = first.get_by_role('combobox', name='Effort', exact=True)
        config_mode = first.get_by_role('combobox', name='Mode', exact=True)
        expect(model_selector).to_have_value('fast')
        expect(effort_selector).to_have_value('medium')
        expect(config_mode).to_have_value('code')
        expect(first.get_by_role('button', name='Agent Commands', exact=True)).to_have_count(0)
        for width in [320, 260]:
            first.set_viewport_size({'width': width, 'height': 900})
            positions = [control.bounding_box() for control in [config_mode, model_selector, effort_selector, first.get_by_role('button', name='Send', exact=True)]]
            assert all(box and box['width'] > 20 for box in positions), positions
            assert max(box['y'] for box in positions) - min(box['y'] for box in positions) <= 2, positions
            assert all(left['x'] + left['width'] <= right['x'] + 1 for left, right in zip(positions, positions[1:])), positions
            assert first.evaluate('document.documentElement.scrollWidth <= innerWidth'), positions
        first.screenshot(path=str(artifacts / 'acp-composer-single-row.png'), full_page=True)
        effort_selector.select_option('high')
        first.wait_for_function("window.__model.controls.configOptions.find(option => option.id === 'effort')?.currentValue === 'high' && !window.__model.controls.configuring")
        config_mode.select_option('ask')
        first.wait_for_function("window.__model.controls.configOptions.find(option => option.id === 'mode')?.currentValue === 'ask' && !window.__model.controls.configuring")
        expect(thinking).not_to_be_visible()
        first.get_by_role('button', name='More Session Options', exact=True).click()
        expect(thinking).not_to_be_checked()
        expect(first.get_by_role('combobox', name='Session Mode', exact=True)).to_have_count(0)
        thinking.press('Escape')

        # Typing a command opens completion without moving focus or sending a prompt.
        command_list = first.get_by_role('listbox', name='Agent Commands', exact=True)
        composer.fill('/')
        expect(command_list.get_by_role('option')).to_have_count(2)
        expect(composer).to_be_focused()
        composer.press('ArrowDown')
        expect(command_list.get_by_role('option', name='/review', exact=False)).to_have_attribute('aria-selected', 'true')
        composer.press('Enter')
        expect(composer).to_have_value('/review ')
        expect(command_list).to_have_count(0)
        composer.fill('/ex')
        expect(command_list.get_by_role('option')).to_have_count(1)
        composer.press('Tab')
        expect(composer).to_have_value('/explain ')
        expect(composer).to_be_focused()
        composer.fill('/')
        composer.press('ArrowUp')
        expect(command_list.get_by_role('option', name='/review', exact=False)).to_have_attribute('aria-selected', 'true')
        composer.press('Escape')
        expect(command_list).to_have_count(0)
        expect(composer).to_have_value('/')
        composer.fill('/ex')
        composer.dispatch_event('compositionstart')
        expect(command_list).to_have_count(0)
        composer.dispatch_event('keydown', {'key': 'Enter', 'code': 'Enter', 'isComposing': True})
        expect(composer).to_have_value('/ex')
        composer.dispatch_event('compositionend')
        expect(command_list).to_be_visible()
        composer.press('Shift+Enter')
        expect(composer).to_have_value('/ex\n')
        expect(command_list).to_have_count(0)
        for text in ['Look at /src', '/unknown', '/explain arguments']:
            composer.fill(text)
            expect(command_list).to_have_count(0)
        # Completing at the start preserves an existing draft as arguments.
        composer.fill('/ 保留的草稿')
        composer.press('Home')
        composer.press('ArrowRight')
        expect(command_list).to_be_visible()
        first.screenshot(path=str(artifacts / 'acp-slash-completion.png'), full_page=True)
        command_list.get_by_role('option', name='/explain', exact=False).click()
        expect(composer).to_have_value('/explain 保留的草稿')
        expect(composer).to_be_focused()
        saved_draft(first, '/explain 保留的草稿')
        controls_journal = inspect()['entries'][0]['journals'][7]
        assert not any(json.loads(line).get('method') == 'session/prompt' for line in controls_journal.splitlines())
        first.set_viewport_size({'width': 1000, 'height': 900})
        model_selector.select_option('deep')
        first.wait_for_function("window.__model.controls.configOptions.find(option => option.id === 'model')?.currentValue === 'deep' && !window.__model.controls.configuring")
        expect(model_selector).to_have_value('deep')
        first.get_by_role('button', name='More Session Options', exact=True).click()
        thinking.click()
        first.wait_for_function("window.__model.controls.configOptions.find(option => option.id === 'thinking')?.currentValue === true && !window.__model.controls.configuring")
        expect(thinking).to_be_checked()
        expect(composer).to_have_value('/explain 保留的草稿')
        thinking.press('Escape')

        send(first, 'session-updates')
        connected(first)
        expect(first.get_by_text('Agent session: 测试会话标题', exact=True)).not_to_be_visible()
        chat_action(first, 'Task and Session Info')
        expect(first.get_by_text('Agent session: 测试会话标题', exact=True)).to_be_visible()
        expect(first.get_by_label('Session Usage', exact=True)).to_contain_text('1,200 / 8,000 tokens')
        expect(first.get_by_label('Session Usage', exact=True)).to_contain_text('0.02 USD')
        expect(first.get_by_text('会话更新提示', exact=True)).to_be_visible()
        expect(first.locator('.acp-transcript')).not_to_contain_text('会话更新提示')
        expect(first.get_by_text('Compaction Complete', exact=True)).to_be_visible()
        expect(first.get_by_text('已保留任务目标与关键结论', exact=False)).to_be_visible()
        thought = first.locator('.acp-message-thought')
        expect(thought.locator('.acp-markdown')).not_to_be_visible()
        thought.get_by_text('Thoughts', exact=True).click()
        expect(thought.locator('.acp-markdown')).to_have_text('正在检查任务上下文')
        first.screenshot(path=str(artifacts / 'acp-session-controls.png'), full_page=True)

        send(first, 'hold')
        first.wait_for_function("window.__model.status === 'running'")
        expect(model_selector).to_be_disabled()
        first.get_by_role('button', name='More Session Options', exact=True).click()
        expect(thinking).to_be_disabled()
        first.get_by_role('dialog', name='More Session Options', exact=True).press('Escape')
        first.get_by_role('button', name='Stop Turn', exact=True).click()
        connected(first)
        chat_action(first, 'Disconnect')
        first.wait_for_function("window.__model.status === 'disconnected'")
        expect(model_selector).to_have_count(0)
        expect(thinking).to_have_count(0)
        expect(first.get_by_label('Session Usage', exact=True)).to_have_count(0)
        expect(first.get_by_text('会话更新提示', exact=True)).to_have_count(0)
        expect(first.get_by_role('button', name='Agent Commands', exact=True)).to_have_count(0)
        first.reload()
        connected(first)
        expect(model_selector).to_be_enabled()

        use_agent(first, 'legacy-modes')
        new_session(first)
        connected(first)
        mode_selector = first.get_by_role('combobox', name='Session Mode', exact=True)
        expect(mode_selector).to_have_value('ask')
        mode_selector.select_option('code')
        first.wait_for_function("window.__model.controls.modes.currentModeId === 'code' && !window.__model.controls.configuring")
        expect(mode_selector).to_have_value('code')
        expect(model_selector).to_have_count(0)

        send(first, 'tool-progress')
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_have_text('Tool progress completed')
        connected(first)
        activity = first.locator('.acp-message-tool').filter(has_text='Tests completed').last
        expect(activity.locator('.acp-tool-detail')).not_to_be_visible()
        activity.locator('summary').click()
        expect(activity.locator('.acp-tool-detail')).to_contain_text('Final output')
        activity.locator('summary').click()

        # Read and copy formatted replies, while keeping untrusted content inert.
        first.context.grant_permissions(['clipboard-read', 'clipboard-write'])
        remote_images = []
        first.on('request', lambda request: remote_images.append(request.url) if 'invalid.example' in request.url else None)
        code = 'const page = input.page ?? 1;'
        markdown = '\n## Review Summary\n\n- **Compatible** defaults.\n- Add a regression test.\n\n```ts\n' + code + '\n```\n\n| Parameter | Default |\n| --- | --- |\n| page | 1 |\n\n![untrusted image](https://invalid.example/image.png)\n[blocked](command:workbench.action.closeWindow)'
        send(first, markdown)
        expect(first.locator('.acp-markdown h2').last).to_have_text('Review Summary')
        connected(first)
        expect(first.locator('.acp-markdown table').last).to_contain_text('Parameter')
        expect(first.locator('.acp-markdown pre').last).to_have_text(code)
        first.get_by_role('button', name='Copy Code', exact=True).last.click()
        expect(first.get_by_role('button', name='Copied', exact=True)).to_be_visible()
        assert first.evaluate('navigator.clipboard.readText()') == code
        assert first.locator('.acp-transcript img, .acp-transcript a[href^="command:"]').count() == 0
        assert remote_images == []
        first.set_viewport_size({'width': 320, 'height': 740})
        history = first.get_by_role('log', name='Conversation History')
        history.evaluate('element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); }')
        expect(first.get_by_role('button', name='Jump to Latest', exact=True)).to_be_visible()
        first.get_by_role('button', name='Jump to Latest', exact=True).click()
        first.wait_for_function('document.querySelector(".acp-transcript").scrollHeight - document.querySelector(".acp-transcript").scrollTop - document.querySelector(".acp-transcript").clientHeight < 32')
        expect(first.get_by_role('button', name='Jump to Latest', exact=True)).to_have_count(0)
        assert first.evaluate('document.documentElement.scrollWidth <= innerWidth')
        first.screenshot(path=str(artifacts / 'acp-markdown-sidebar.png'), full_page=True)

        first.set_viewport_size({'width': 360, 'height': 900})
        first.evaluate("document.body.className = 'vscode-dark'")
        first.add_style_tag(content=''' :root { --vscode-editor-background:#1f1f1f; --vscode-editor-foreground:#ccc;
          --vscode-button-background:#0078d4; --vscode-button-foreground:white;
          --vscode-input-background:#313131; --vscode-descriptionForeground:#aaa;
          --vscode-textCodeBlock-background:#292929; --vscode-button-secondaryBackground:#313131;
          --vscode-button-secondaryForeground:#ccc; --vscode-widget-border:#555; }''')
        assert first.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        expect(first.get_by_role('textbox', name='Message', exact=True)).to_have_css('color', 'rgb(204, 204, 204)')
        first.screenshot(path=str(artifacts / 'acp-dark-mobile.png'), full_page=True)
        assert inspect()['primaryStatus'] == ''
        assert not errors, errors
        assert first.evaluate('window.__hostError') is None
        assert second.evaluate('window.__hostError') is None
        browser.close()
    print('ACP browser flows passed: task isolation, parallel conversations, permissions, cancellation, delayed completion with reload and follow-up, unacknowledged completion clears, batched selection appends, in-flight drafts, stale models/sends, new-conversation edits, reopened-turn acknowledgement, restore, crash, authentication, failed-profile recovery, safe text, single-row mode/model/effort controls, slash completion with keyboard/mouse/IME and no implicit send, thought/usage updates and disconnected controls.')
finally:
    host.terminate()
    host.wait(timeout=30)
