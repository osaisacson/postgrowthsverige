# Builds import/content.json + import/files/ from the Obsidian vault uploads.
import base64, json, os, re, shutil, sys
U = sys.argv[1]; P = sys.argv[2]; OUT = sys.argv[3]
def md(name): return open(os.path.join(U, name), encoding='utf-8').read()
files = os.path.join(OUT, 'files')
pages = []
def add(section, title, src, home=False):
    pages.append({'section': section, 'title': title, 'content': md(src).lstrip('\n'), 'home': home})
add(None, 'Post-growth Sverige', 'dcda47c6-Post-growth_Sverige.md', True)
add('Evenemang', '2026-05-03 - Post-growth Göteborg', 'cb0e9dcc-2026-05-03_-_Post-growth_G_teborg.md')
add('I pressen', '2026-03-31 Vi kan inte låta BNP styra världen', 'a3ba0608-2026-03-31_Vi_kan_inte_l_ta_BNP_styra_v_rlden.md')
add('I pressen', '2026-09-03 Pressmeddelande, Valenkät', '50ef10e9-2026-09-03_Pressmeddelande_Valenk_t.md')
add('Om Post-growth', 'Backgrund', '84e05865-Backgrund.md')
add('Om Post-growth', 'Definition', 'fe5ef30e-Definition.md')
add('Om Post-growth', 'Vision, Aktion & Mål', '55ad9517-Vision_Aktion__M_l.md')
add('Engagemang', 'Bli medlem', 'a5c4ead3-Bli_medlem.md')
add('Engagemang', 'WhatsApp', 'a5f7ba87-WhatsApp.md')
add('Engagemang', 'Instagram', 'f366f308-Instagram.md')
# Pull embedded base64 images out of the Valenkät page into real files.
n = [0]
def repl(m):
    n[0] += 1
    name = f'Valenkät figur {n[0]}.{m.group(1).replace("jpeg","jpg")}'
    open(os.path.join(files, name), 'wb').write(base64.b64decode(m.group(2)))
    return f'![[{name}]]'
for p in pages:
    p['content'] = re.sub(r'!\[[^\]]*\]\(data:image/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)\)', repl, p['content'])
    # Strip the Office "footnote" link that points at a private document editor.
    p['content'] = re.sub(r'\[_\[1\]_\]\(https://oo\.murena\.io[^)]*\)', '', p['content'])
for f in os.listdir(P):
    if f.startswith('Pasted image') or f.startswith('Screenshot'):
        shutil.copy(os.path.join(P, f), os.path.join(files, f))
for src, dst in [('1d4177e2-Post_Growth_Visualised.png', 'Post Growth Visualised.png'),
                 ('6e6c3c33-Beyond_The_Roadmap.png', 'Beyond The Roadmap.png'),
                 ('587e21f5-Beyond_The_Roadmap.jpeg', 'Beyond The Roadmap.jpeg'),
                 ('7058104d-20241209-BeyondtheRoadmap-fullpresentation_Page_240.webp', '20241209-BeyondtheRoadmap-fullpresentation_Page_240.webp'),
                 ('fa9adc68-Screenshot_2026-09-02_at_13.04.30.jpg', 'Screenshot 2026-09-02 at 13.04.30.jpg'),
                 ('8ca97d35-2026-09-03_Pressmeddelande_-_Valenk_t_.pdf', '2026-09-03 Pressmeddelande - Valenkät .pdf')]:
    shutil.copy(os.path.join(U, src), os.path.join(files, dst))
json.dump(pages, open(os.path.join(OUT, 'content.json'), 'w'), ensure_ascii=False, indent=1)
print('pages', len(pages), 'figures', n[0], 'files', len(os.listdir(files)))
