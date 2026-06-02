#!/usr/bin/env python3
"""
SNAKE.EXE — Python/Pygame edition
Requires: pip install pygame
Optional: pip install numpy  (for sound effects)
"""
import pygame, sys, json, math, random, os
from datetime import date
from collections import deque

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

# ── Constants ─────────────────────────────────────────────────────────────────
COLS, ROWS = 24, 24
CELL       = 22
GRID_W     = COLS * CELL   # 528
GRID_H     = ROWS * CELL   # 528
HUD_H      = 68
WIN_W      = GRID_W
WIN_H      = GRID_H + HUD_H
FPS        = 60
TRAIL_LEN  = 28
MAX_BOARD  = 10

HERE           = os.path.dirname(os.path.abspath(__file__))
BOARD_FILE     = os.path.join(HERE, 'snake_scores.json')
SETTINGS_FILE  = os.path.join(HERE, 'snake_settings.json')

# ── Colour palettes ───────────────────────────────────────────────────────────
PALETTES = {
    'snake': [
        ('Cyan',   (0,245,255)), ('Green', (0,255,127)), ('Purple',(168,85,247)),
        ('Pink',  (255,0,204)),  ('Orange',(255,140,0)), ('Yellow',(255,230,0)),
        ('White', (232,234,240)),('Red',   (255,0,60)),
    ],
    'food': [
        ('Red',   (255,0,60)),   ('Orange',(255,102,0)), ('Yellow',(255,230,0)),
        ('Green', (0,255,127)),  ('Pink',  (255,0,204)), ('Purple',(168,85,247)),
        ('Cyan',  (0,245,255)),  ('White', (240,240,240)),
    ],
    'board': [
        ('Void',  (0,6,15)),    ('Black', (1,1,1)),      ('Nebula',(10,0,18)),
        ('Forest',(0,22,8)),    ('Ember', (16,0,4)),     ('Ocean', (0,13,26)),
        ('Steel', (8,12,16)),   ('Slate', (10,10,10)),
    ],
}

DEFAULT_SETTINGS = {
    'snake': (0,245,255), 'food': (255,0,60), 'board': (0,6,15), 'muted': False
}

# ── UI colours ────────────────────────────────────────────────────────────────
ACCENT = (0,245,255)
RED    = (255,0,60)
GOLD   = (255,215,0)
TEXT   = (232,234,240)
MUTED  = (58,74,90)
MUTED2 = (106,122,138)
DARK   = (2,10,20)

# ── Settings ──────────────────────────────────────────────────────────────────
def load_settings():
    try:
        raw = json.load(open(SETTINGS_FILE))
        s = dict(DEFAULT_SETTINGS)
        for k in ('snake','food','board'):
            if k in raw: s[k] = tuple(raw[k])
        s['muted'] = bool(raw.get('muted', False))
        return s
    except:
        return dict(DEFAULT_SETTINGS)

def save_settings(s):
    try:
        json.dump({k: list(v) if isinstance(v,tuple) else v for k,v in s.items()},
                  open(SETTINGS_FILE,'w'))
    except: pass

# ── Leaderboard ───────────────────────────────────────────────────────────────
def load_board():
    try:    return json.load(open(BOARD_FILE))
    except: return []

def save_board(b):
    try: json.dump(b, open(BOARD_FILE,'w'))
    except: pass

def qualifies(score):
    if score <= 0: return False
    b = load_board()
    return len(b) < MAX_BOARD or score > b[-1]['score']

def add_entry(name, score):
    b = load_board()
    b.append({'name': (name or 'AAA')[:3].upper(), 'score': score,
              'date': str(date.today())})
    b.sort(key=lambda x: x['score'], reverse=True)
    b = b[:MAX_BOARD]
    save_board(b)
    return b

def top_score():
    b = load_board()
    return b[0]['score'] if b else 0

# ── Audio ─────────────────────────────────────────────────────────────────────
_sounds = {}

def init_audio():
    if not HAS_NUMPY: return
    try:
        pygame.mixer.init(frequency=44100, size=-16, channels=2, buffer=512)
        SR = 44100

        def tone(freq, dur, wtype='square', vol=0.22):
            n  = int(SR * dur)
            t  = np.linspace(0, dur, n, False)
            if wtype == 'sine':      w = np.sin(2*np.pi*freq*t)
            elif wtype == 'saw':     w = 2*(t*freq - np.floor(t*freq+0.5))
            else:                    w = np.sign(np.sin(2*np.pi*freq*t))
            env       = np.linspace(1,0,n)**1.4
            w         = (w*env*vol*32767).clip(-32767,32767).astype(np.int16)
            return np.column_stack([w,w])

        def noise(dur, vol=0.18):
            n  = int(SR * dur)
            w  = np.random.uniform(-1,1,n)
            w *= np.linspace(1,0,n)**1.2
            w  = (w*vol*32767).clip(-32767,32767).astype(np.int16)
            return np.column_stack([w,w])

        def mix(*parts):
            # parts = (buf, delay_sec)
            max_n = max(int(d*SR)+len(b) for b,d in parts)
            out   = np.zeros((max_n,2), np.int32)
            for b, d in parts:
                s = int(d*SR); e = s+len(b)
                out[s:min(e,max_n)] += b[:max_n-s]
            out = out.clip(-32767,32767).astype(np.int16)
            return pygame.sndarray.make_sound(out)

        _sounds['eat'] = mix(
            (tone(440,0.04,'square',0.10), 0.00),
            (tone(660,0.05,'square',0.09), 0.04),
            (tone(1100,0.07,'sine',0.07),  0.08))

        _sounds['levelup'] = mix(
            (tone(523,0.07,'square',0.10), 0.00),
            (tone(659,0.07,'square',0.10), 0.08),
            (tone(784,0.07,'square',0.10), 0.16),
            (tone(1047,0.13,'sine',0.09), 0.24))

        _sounds['death'] = mix(
            (tone(260,0.08,'saw',0.22),  0.00),
            (tone(180,0.10,'saw',0.18),  0.07),
            (tone(120,0.14,'saw',0.14),  0.15),
            (tone(55, 0.38,'sine',0.26), 0.12),
            (noise(0.14, 0.18),          0.00))

        _sounds['start'] = mix(
            (tone(262,0.08,'sine',0.10), 0.00),
            (tone(330,0.08,'sine',0.10), 0.09),
            (tone(392,0.08,'sine',0.10), 0.18),
            (tone(523,0.15,'sine',0.13), 0.27))

        _sounds['pause']  = mix((tone(660,0.05,'square',0.07),0.00),
                                 (tone(440,0.05,'square',0.05),0.06))
        _sounds['click']  = pygame.sndarray.make_sound(tone(700,0.04,'square',0.05))
        _sounds['unmute'] = pygame.sndarray.make_sound(tone(880,0.08,'sine',0.06))
    except Exception as e:
        print(f'Audio init failed: {e}')

def sfx(name, settings):
    if settings.get('muted') or name not in _sounds: return
    try: _sounds[name].play()
    except: pass

# ── Drawing helpers ───────────────────────────────────────────────────────────
def dim(color, f):
    return tuple(max(0, int(c*f)) for c in color)

def glow_rect(surf, color, rect, spread=12, strength=70):
    for i in range(spread, 0, -3):
        a = int(strength * (i/spread)**2 * 0.35)
        s = pygame.Surface((rect.w+i*2, rect.h+i*2), pygame.SRCALPHA)
        s.fill((*color, a))
        surf.blit(s, (rect.x-i, rect.y-i), special_flags=pygame.BLEND_RGBA_ADD)

def glow_poly(surf, color, pts, spread=8, strength=60):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    bx = int(min(xs))-spread; by = int(min(ys))-spread
    bw = int(max(xs))-bx+spread; bh = int(max(ys))-by+spread
    s = pygame.Surface((bw+spread, bh+spread), pygame.SRCALPHA)
    lp = [(p[0]-bx, p[1]-by) for p in pts]
    for i in range(spread, 0, -2):
        a  = int(strength*(i/spread)**2*0.4)
        cx = sum(p[0] for p in lp)/len(lp)
        cy = sum(p[1] for p in lp)/len(lp)
        sc = [(cx+(p[0]-cx)*(1+i*0.05), cy+(p[1]-cy)*(1+i*0.05)) for p in lp]
        pygame.draw.polygon(s, (*color,a), sc, 2)
    surf.blit(s, (bx, by), special_flags=pygame.BLEND_RGBA_ADD)
    pygame.draw.polygon(surf, color, pts, 2)

def scanlines(surf):
    w = surf.get_width()
    sl = pygame.Surface((w, 2), pygame.SRCALPHA)
    sl.fill((0,245,255,6))
    for y in range(0, surf.get_height(), 4):
        surf.blit(sl, (0, y))

def bg_grid(surf, board_color):
    surf.fill(board_color)
    gc = tuple(min(255,int(c*0.07)) for c in (0,245,255))
    for x in range(0, GRID_W+1, CELL):
        pygame.draw.line(surf, gc, (x,0),(x,GRID_H))
    for y in range(0, GRID_H+1, CELL):
        pygame.draw.line(surf, gc, (0,y),(GRID_W,y))
    dc = tuple(min(255,int(c*0.13)) for c in (0,245,255))
    for x in range(0, GRID_W+1, CELL):
        for y in range(0, GRID_H+1, CELL):
            pygame.draw.rect(surf, dc, (x-1,y-1,2,2))

# ── Fonts ─────────────────────────────────────────────────────────────────────
def make_fonts():
    pygame.font.init()
    mono = 'monospace'
    for name in ('JetBrains Mono','Courier New','Lucida Console'):
        if pygame.font.match_font(name): mono = name; break
    return {
        'xl':    pygame.font.SysFont(mono, 52, bold=True),
        'lg':    pygame.font.SysFont(mono, 32, bold=True),
        'md':    pygame.font.SysFont(mono, 18, bold=True),
        'sm':    pygame.font.SysFont(mono, 13),
    }

def txt(fonts, key, text, color):
    return fonts[key].render(text, True, color)

def blit_center(surf, img, cx, y):
    surf.blit(img, (cx - img.get_width()//2, y))

# ── Button ────────────────────────────────────────────────────────────────────
def button(surf, fonts, label, rect, hover=False, color=ACCENT):
    bc = color if hover else dim(color, 0.4)
    pygame.draw.rect(surf, dim(color, 0.06), rect)
    pygame.draw.rect(surf, bc, rect, 1)
    if hover:
        gs = pygame.Surface((rect.w+6, rect.h+6), pygame.SRCALPHA)
        pygame.draw.rect(gs, (*color,25), gs.get_rect(), 1)
        surf.blit(gs, (rect.x-3, rect.y-3), special_flags=pygame.BLEND_RGBA_ADD)
    lbl = fonts['md'].render(label, True, color if hover else MUTED2)
    surf.blit(lbl, lbl.get_rect(center=rect.center))

# ── Particles ─────────────────────────────────────────────────────────────────
class Particle:
    __slots__ = ('x','y','vx','vy','color','size','life','decay')
    def __init__(self,x,y,vx,vy,color,size,life,decay):
        self.x=x; self.y=y; self.vx=vx; self.vy=vy
        self.color=color; self.size=size; self.life=life; self.decay=decay
    def tick(self):
        self.x+=self.vx; self.y+=self.vy
        self.vx*=0.92;   self.vy*=0.92
        self.life-=self.decay
        return self.life>0
    def draw(self,surf):
        sz = max(1,int(self.size*self.life))
        s  = pygame.Surface((sz*2,sz*2), pygame.SRCALPHA)
        s.fill((*self.color, int(self.life*220)))
        surf.blit(s,(int(self.x)-sz,int(self.y)-sz), special_flags=pygame.BLEND_RGBA_ADD)

def burst(particles, gx, gy, color, n=16, spd_range=(1.5,4)):
    cx=gx*CELL+CELL//2; cy=gy*CELL+CELL//2
    for i in range(n):
        a=i/n*math.pi*2; spd=spd_range[0]+random.random()*(spd_range[1]-spd_range[0])
        particles.append(Particle(cx,cy,math.cos(a)*spd,math.sin(a)*spd,
                                  color,2+random.random()*3,1.0,0.03+random.random()*0.03))

# ── Game logic ────────────────────────────────────────────────────────────────
def speed_for(s):
    for threshold,ms in ((200,45),(120,55),(70,70),(40,88),(20,105),(8,120)):
        if s>=threshold: return ms
    return 145

def level_for(s):
    for i,(t,_) in enumerate(((200,0),(120,0),(70,0),(40,0),(20,0),(8,0))):
        if s>=t: return 6-i
    return 0

class Snake:
    def __init__(self, settings):
        self.cfg       = settings
        self.snake     = [(12,12),(11,12),(10,12)]
        self.dir       = (1,0)
        self.ndir      = (1,0)
        self.score     = 0
        self.tick_ms   = 145
        self.tick_acc  = 0.0
        self.trail     = []   # [(x,y,age)]
        self.particles = []
        self.flash     = 0.0
        self.food_ang  = 0.0
        self.food_pls  = 0.0
        self.food      = self._spawn_food()
        self.alive     = True
        self.paused    = False

    def _spawn_food(self):
        occ = set(self.snake)
        empty = [(x,y) for x in range(COLS) for y in range(ROWS) if (x,y) not in occ]
        return random.choice(empty)

    def steer(self, d):
        if d[0]!=-self.dir[0] or d[1]!=-self.dir[1]:
            self.ndir = d

    def update(self, dt):
        if not self.alive or self.paused: return None
        self.food_ang += dt*0.0018
        self.food_pls += dt*0.004
        self.trail = [(x,y,a+1) for x,y,a in self.trail if a+1<TRAIL_LEN]
        self.particles = [p for p in self.particles if p.tick()]
        if self.flash>0: self.flash = max(0.0, self.flash-dt*0.004)
        self.tick_acc += dt
        if self.tick_acc >= self.tick_ms:
            self.tick_acc -= self.tick_ms
            return self._tick()
        return None

    def _tick(self):
        self.dir = self.ndir
        hx=(self.snake[0][0]+self.dir[0])%COLS
        hy=(self.snake[0][1]+self.dir[1])%ROWS
        head=(hx,hy)
        if head in self.snake:
            self.alive = False
            self.flash = 1.0
            burst(self.particles, self.snake[0][0], self.snake[0][1],
                  self.cfg['snake'], 24, (1,4))
            return 'death'
        self.snake.insert(0,head)
        if head==self.food:
            prev = level_for(self.score)
            self.score += 10
            self.tick_ms = speed_for(self.score)
            burst(self.particles,self.food[0],self.food[1],self.cfg['food'],16,(1.5,4))
            self.food = self._spawn_food()
            return 'levelup' if level_for(self.score)>prev else 'eat'
        tail = self.snake.pop()
        self.trail.append((tail[0],tail[1],0))
        return None

# ── Draw game ─────────────────────────────────────────────────────────────────
def draw_game(win, game, fonts, grid_surf, hud_surf):
    sc = game.cfg['snake']
    fc = game.cfg['food']
    bc = game.cfg['board']

    # Grid background
    bg_grid(grid_surf, bc)

    # Trail
    for tx,ty,age in game.trail:
        p     = age/TRAIL_LEN
        alpha = int((1-p)*120)
        inset = int(2+p*4); sz=CELL-inset*2
        if sz<=0: continue
        s=pygame.Surface((sz,sz),pygame.SRCALPHA)
        s.fill((*dim(sc,0.65*(1-p)+0.1), alpha))
        grid_surf.blit(s,(tx*CELL+inset,ty*CELL+inset),special_flags=pygame.BLEND_RGBA_ADD)

    # Food
    cx=game.food[0]*CELL+CELL//2; cy=game.food[1]*CELL+CELL//2
    pulse=math.sin(game.food_pls*2)*0.3+0.7
    sz=int((CELL//2-2)*(0.85+pulse*0.15))
    ang=game.food_ang
    diamond=[(cx+sz*math.cos(ang+i*math.pi/2), cy+sz*math.sin(ang+i*math.pi/2)) for i in range(4)]
    glow_poly(grid_surf, fc, diamond, spread=10, strength=60)

    # Snake
    length=len(game.snake)
    for i in range(length-1,-1,-1):
        sx,sy=game.snake[i]; t=i/max(length-1,1); is_head=(i==0)
        if is_head:
            r=pygame.Rect(sx*CELL+1,sy*CELL+1,CELL-2,CELL-2)
            glow_rect(grid_surf,sc,r,spread=14,strength=80)
            pygame.draw.rect(grid_surf,sc,r)
            core=pygame.Rect(sx*CELL+5,sy*CELL+5,CELL-10,CELL-10)
            cs=pygame.Surface(core.size,pygame.SRCALPHA); cs.fill((255,255,255,130))
            grid_surf.blit(cs,core,special_flags=pygame.BLEND_RGBA_ADD)
        else:
            bright=1-t*0.55; alpha=int((0.9-t*0.4)*255)
            s=pygame.Surface((CELL-4,CELL-4),pygame.SRCALPHA)
            s.fill((*dim(sc,bright),alpha))
            grid_surf.blit(s,(sx*CELL+2,sy*CELL+2),special_flags=pygame.BLEND_RGBA_ADD)
            if t<0.35:
                gs=pygame.Surface((CELL+4,CELL+4),pygame.SRCALPHA)
                gs.fill((*sc, int(35*(1-t/0.35))))
                grid_surf.blit(gs,(sx*CELL-2,sy*CELL-2),special_flags=pygame.BLEND_RGBA_ADD)

    # Eyes
    if game.snake:
        hx2,hy2=game.snake[0]; ec=bc if sum(bc)>15 else (0,2,4); e=4; dx,dy=game.dir
        if dx==1:  eyes=[(hx2*CELL+CELL-6,hy2*CELL+e),(hx2*CELL+CELL-6,hy2*CELL+CELL-e-3)]
        elif dx==-1:eyes=[(hx2*CELL+3,hy2*CELL+e),(hx2*CELL+3,hy2*CELL+CELL-e-3)]
        elif dy==-1:eyes=[(hx2*CELL+e,hy2*CELL+3),(hx2*CELL+CELL-e-3,hy2*CELL+3)]
        else:       eyes=[(hx2*CELL+e,hy2*CELL+CELL-6),(hx2*CELL+CELL-e-3,hy2*CELL+CELL-6)]
        for ex,ey in eyes: pygame.draw.rect(grid_surf,ec,(ex,ey,3,3))

    # Particles
    for p in game.particles: p.draw(grid_surf)

    # Death flash
    if game.flash>0:
        fs=pygame.Surface((GRID_W,GRID_H),pygame.SRCALPHA)
        fs.fill((*fc,int(game.flash*90))); grid_surf.blit(fs,(0,0))

    # Pause overlay
    if game.paused:
        ov=pygame.Surface((GRID_W,GRID_H),pygame.SRCALPHA); ov.fill((0,0,0,140))
        grid_surf.blit(ov,(0,0))
        pt=fonts['md'].render('// PAUSED — PRESS P', True, sc)
        grid_surf.blit(pt,pt.get_rect(center=(GRID_W//2,GRID_H//2)))

    win.blit(grid_surf,(0,0))

    # HUD
    hud_surf.fill((0,4,10))
    pygame.draw.line(hud_surf,dim(ACCENT,0.18),(0,0),(WIN_W,0))
    lvl=level_for(game.score)
    items=[
        (fonts['sm'].render('SCORE',True,MUTED),(16,6)),
        (fonts['lg'].render(str(game.score),True,sc),(16,22)),
        (fonts['sm'].render('BEST',True,MUTED),(130,6)),
        (fonts['lg'].render(str(top_score()),True,RED),(130,22)),
    ]
    if lvl:
        lv=fonts['sm'].render(f'// speed level {lvl}',True,MUTED)
        items.append((lv,(WIN_W-lv.get_width()-12, HUD_H//2-lv.get_height()//2)))
    for img,(x,y) in items: hud_surf.blit(img,(x,y))
    win.blit(hud_surf,(0,GRID_H))

# ── Screens ───────────────────────────────────────────────────────────────────
def draw_bg(surf):
    surf.fill(DARK)
    for x in range(0,WIN_W,CELL): pygame.draw.line(surf,(0,14,20),(x,0),(x,WIN_H))
    for y in range(0,WIN_H,CELL): pygame.draw.line(surf,(0,14,20),(0,y),(WIN_W,y))

def screen_menu(win, fonts, settings, clock):
    btns = [('[ PLAY GAME ]','play'),('[ CUSTOMISE ]','customise'),
            ('[ LEADERBOARD ]','leaderboard'),('[ QUIT ]','quit')]
    rects = [pygame.Rect(WIN_W//2-105, 260+i*52, 210, 42) for i in range(len(btns))]
    t=0
    while True:
        dt=clock.tick(FPS); t+=dt
        mx,my=pygame.mouse.get_pos()
        for ev in pygame.event.get():
            if ev.type==pygame.QUIT: return 'quit'
            if ev.type==pygame.KEYDOWN:
                if ev.key==pygame.K_RETURN: return 'play'
                if ev.key==pygame.K_ESCAPE: return 'quit'
                if ev.key==pygame.K_l: return 'leaderboard'
                if ev.key==pygame.K_c: return 'customise'
                if ev.key==pygame.K_m:
                    settings['muted']=not settings['muted']; save_settings(settings)
                    if not settings['muted']: sfx('unmute',settings)
            if ev.type==pygame.MOUSEBUTTONDOWN and ev.button==1:
                for rect,(_,action) in zip(rects,btns):
                    if rect.collidepoint(mx,my):
                        sfx('click',settings); return action

        draw_bg(win)
        tag=txt(fonts,'sm','// snake.exe  v2.0',MUTED)
        win.blit(tag,(18,18))
        pulse=math.sin(t*0.002)*0.15+0.85
        t1=txt(fonts,'xl','ENTER',TEXT)
        t2=txt(fonts,'xl','THE GRID',tuple(int(c*pulse) for c in ACCENT))
        blit_center(win,t1,WIN_W//2,110)
        blit_center(win,t2,WIN_W//2,166)
        pygame.draw.line(win,dim(ACCENT,0.3),(WIN_W//2-55,248),(WIN_W//2+55,248))
        for rect,(label,action) in zip(rects,btns):
            hover=rect.collidepoint(mx,my)
            col=RED if action=='quit' else ACCENT
            button(win,fonts,label,rect,hover,col)
        ms=txt(fonts,'sm','[M] MUTED' if settings['muted'] else '[M] SOUND ON',
               MUTED if settings['muted'] else MUTED2)
        win.blit(ms,(WIN_W-ms.get_width()-14,14))
        scanlines(win)
        pygame.display.flip()

def screen_customise(win, fonts, settings, clock):
    SW,GAP=30,8
    sections=['snake','food','board']
    labels={'snake':'Snake Colour','food':'Food Colour','board':'Board Colour'}
    ys={'snake':130,'food':220,'board':310}
    back_r=pygame.Rect(WIN_W//2-110,WIN_H-66,100,40)
    play_r=pygame.Rect(WIN_W//2+10, WIN_H-66,100,40)

    def sw_rects(key):
        pal=PALETTES[key]; total=(SW+GAP)*len(pal)-GAP
        sx=(WIN_W-total)//2; y=ys[key]
        return [pygame.Rect(sx+i*(SW+GAP),y,SW,SW) for i in range(len(pal))]

    while True:
        clock.tick(FPS)
        mx,my=pygame.mouse.get_pos()
        for ev in pygame.event.get():
            if ev.type==pygame.QUIT: save_settings(settings); pygame.quit(); sys.exit()
            if ev.type==pygame.KEYDOWN:
                if ev.key in (pygame.K_ESCAPE,pygame.K_RETURN):
                    save_settings(settings); return
            if ev.type==pygame.MOUSEBUTTONDOWN and ev.button==1:
                if back_r.collidepoint(mx,my) or play_r.collidepoint(mx,my):
                    sfx('click',settings); save_settings(settings); return
                for key in sections:
                    for i,r in enumerate(sw_rects(key)):
                        if r.collidepoint(mx,my):
                            sfx('click',settings)
                            settings[key]=PALETTES[key][i][1]

        draw_bg(win)
        win.blit(txt(fonts,'sm','// appearance',MUTED),(18,18))
        win.blit(txt(fonts,'lg','CUSTOMISE',TEXT),(18,40))

        for key in sections:
            lbl=txt(fonts,'sm',labels[key].upper(),MUTED2)
            blit_center(win,lbl,WIN_W//2,ys[key]-22)
            rects=sw_rects(key)
            for i,(r,(label,color)) in enumerate(zip(rects,PALETTES[key])):
                is_board=(key=='board')
                sel=(settings[key]==color)
                if is_board: pygame.draw.rect(win,color,r,border_radius=4)
                else:        pygame.draw.circle(win,color,r.center,SW//2)
                if sel:
                    for g in range(4,0,-1):
                        if is_board: pygame.draw.rect(win,(*color,int(60*g/4)),r.inflate(g*4,g*4),1)
                        else:        pygame.draw.circle(win,(*color,int(60*g/4)),r.center,SW//2+g*2,1)
                    if is_board: pygame.draw.rect(win,(255,255,255),r,2)
                    else:        pygame.draw.circle(win,(255,255,255),r.center,SW//2,2)
                    ck=txt(fonts,'sm','✓',(0,0,0)); win.blit(ck,ck.get_rect(center=r.center))
                else:
                    if is_board: pygame.draw.rect(win,(50,60,70),r,1)
                    else:        pygame.draw.circle(win,(50,60,70),r.center,SW//2,1)

        hover_b=back_r.collidepoint(mx,my); hover_p=play_r.collidepoint(mx,my)
        button(win,fonts,'[ BACK ]',back_r,hover_b,MUTED2)
        button(win,fonts,'[ PLAY ]',play_r,hover_p,ACCENT)
        scanlines(win)
        pygame.display.flip()

def screen_leaderboard(win, fonts, settings, clock, highlight=None):
    close_r=pygame.Rect(WIN_W//2-110,WIN_H-66,100,40)
    play_r =pygame.Rect(WIN_W//2+10, WIN_H-66,100,40)
    board=load_board()
    rank_colors=[GOLD,(192,200,208),(205,127,50)]
    while True:
        clock.tick(FPS)
        mx,my=pygame.mouse.get_pos()
        for ev in pygame.event.get():
            if ev.type==pygame.QUIT: pygame.quit(); sys.exit()
            if ev.type==pygame.KEYDOWN:
                if ev.key in (pygame.K_ESCAPE,pygame.K_l): return None
                if ev.key==pygame.K_RETURN: return 'play'
            if ev.type==pygame.MOUSEBUTTONDOWN and ev.button==1:
                if close_r.collidepoint(mx,my): sfx('click',settings); return None
                if play_r.collidepoint(mx,my):  sfx('click',settings); return 'play'

        draw_bg(win)
        win.blit(txt(fonts,'sm','// top scores',MUTED),(18,18))
        win.blit(txt(fonts,'lg','LEADERBOARD',TEXT),(18,40))
        pygame.draw.line(win,dim(ACCENT,0.25),(18,80),(WIN_W-18,80))

        if not board:
            em=txt(fonts,'md','// no scores yet — be first',MUTED)
            blit_center(win,em,WIN_W//2,WIN_H//2)
        else:
            hy=96
            for col_txt,x in [('RANK',18),('NAME',90),('SCORE',188),('DATE',296)]:
                win.blit(txt(fonts,'sm',col_txt,MUTED),(x,hy))
            pygame.draw.line(win,dim(ACCENT,0.15),(18,hy+18),(WIN_W-18,hy+18))
            highlighted=False
            for i,e in enumerate(board):
                y=hy+26+i*32
                is_cur=(not highlighted and highlight is not None and e['score']==highlight)
                if is_cur:
                    highlighted=True
                    hl=pygame.Surface((WIN_W-36,28),pygame.SRCALPHA); hl.fill((0,245,255,14))
                    win.blit(hl,(18,y-3))
                rc=rank_colors[i] if i<3 else MUTED
                win.blit(txt(fonts,'md',f'{i+1:02d}',rc),(18,y))
                win.blit(txt(fonts,'md',e['name'],ACCENT if is_cur else TEXT),(90,y))
                win.blit(txt(fonts,'md',str(e['score']),ACCENT),(188,y))
                win.blit(txt(fonts,'sm',e['date'],MUTED),(296,y+3))

        hc=close_r.collidepoint(mx,my); hp=play_r.collidepoint(mx,my)
        button(win,fonts,'[ CLOSE ]',close_r,hc,MUTED2)
        button(win,fonts,'[ PLAY ]', play_r,hp,ACCENT)
        scanlines(win)
        pygame.display.flip()

def screen_name_entry(win, fonts, settings, score, clock):
    name=''; cursor=True; ct=0
    submit_r=pygame.Rect(WIN_W//2+55,WIN_H//2+10,90,42)
    while True:
        dt=clock.tick(FPS); ct+=dt
        if ct>500: cursor=not cursor; ct=0
        mx,my=pygame.mouse.get_pos()
        for ev in pygame.event.get():
            if ev.type==pygame.QUIT: pygame.quit(); sys.exit()
            if ev.type==pygame.KEYDOWN:
                if ev.key==pygame.K_RETURN and name:
                    sfx('click',settings); return name.upper()
                elif ev.key==pygame.K_BACKSPACE: name=name[:-1]
                elif len(name)<3 and ev.unicode.isalpha():
                    name+=ev.unicode.upper()
            if ev.type==pygame.MOUSEBUTTONDOWN and ev.button==1:
                if submit_r.collidepoint(mx,my) and name:
                    sfx('click',settings); return name.upper()

        draw_bg(win)
        blit_center(win,txt(fonts,'sm','// new record',GOLD),WIN_W//2,160)
        t1=txt(fonts,'xl','TOP',TEXT); t2=txt(fonts,'xl','10',GOLD)
        blit_center(win,t1,WIN_W//2-35,188)
        blit_center(win,t2,WIN_W//2+45,188)
        blit_center(win,txt(fonts,'md',f'Score: {score}',MUTED2),WIN_W//2,248)
        blit_center(win,txt(fonts,'sm','ENTER YOUR INITIALS',MUTED2),WIN_W//2,282)
        box=pygame.Rect(WIN_W//2-80,WIN_H//2,120,44)
        pygame.draw.rect(win,dim(ACCENT,0.06),box)
        pygame.draw.rect(win,ACCENT if name else dim(ACCENT,0.3),box,1)
        disp=name+('_' if cursor and len(name)<3 else '')
        inp=fonts['lg'].render(disp or '_',True,ACCENT if name else dim(ACCENT,0.25))
        win.blit(inp,inp.get_rect(center=box.center))
        hs=submit_r.collidepoint(mx,my)
        button(win,fonts,'[ OK ]',submit_r,hs and bool(name),ACCENT)
        scanlines(win)
        pygame.display.flip()

def screen_game_over(win, fonts, settings, score, clock):
    btns=[('[ PLAY AGAIN ]','play'),('[ LEADERBOARD ]','leaderboard'),('[ MAIN MENU ]','menu')]
    rects=[pygame.Rect(WIN_W//2-105,320+i*52,210,42) for i in range(len(btns))]
    t=0
    while True:
        dt=clock.tick(FPS); t+=dt
        mx,my=pygame.mouse.get_pos()
        for ev in pygame.event.get():
            if ev.type==pygame.QUIT: return 'quit'
            if ev.type==pygame.KEYDOWN:
                if ev.key in (pygame.K_r,pygame.K_RETURN): return 'play'
                if ev.key==pygame.K_ESCAPE: return 'menu'
                if ev.key==pygame.K_l: return 'leaderboard'
            if ev.type==pygame.MOUSEBUTTONDOWN and ev.button==1:
                for rect,(_,action) in zip(rects,btns):
                    if rect.collidepoint(mx,my): sfx('click',settings); return action

        draw_bg(win)
        pulse=math.sin(t*0.003)*0.2+0.8
        blit_center(win,txt(fonts,'sm','// system failure',RED),WIN_W//2,178)
        blit_center(win,txt(fonts,'xl','GAME',TEXT),WIN_W//2,198)
        blit_center(win,txt(fonts,'xl','OVER',tuple(int(c*pulse) for c in RED)),WIN_W//2,256)
        blit_center(win,txt(fonts,'md',f'Score: {score}    Best: {top_score()}',MUTED2),WIN_W//2,312)
        for rect,(label,action) in zip(rects,btns):
            hover=rect.collidepoint(mx,my)
            col=RED if action=='play' else ACCENT
            button(win,fonts,label,rect,hover,col)
        scanlines(win)
        pygame.display.flip()

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    pygame.init()
    # Icon must be set before set_mode; handle both normal and PyInstaller frozen paths
    try:
        base = sys._MEIPASS if getattr(sys, 'frozen', False) else os.path.dirname(os.path.abspath(__file__))
        icon = pygame.image.load(os.path.join(base, 'snake_icon.png'))
        pygame.display.set_icon(icon)
    except Exception:
        pass
    win = pygame.display.set_mode((WIN_W, WIN_H))
    pygame.display.set_caption('SNAKE.EXE')
    clock  = pygame.time.Clock()
    fonts  = make_fonts()
    settings = load_settings()
    init_audio()

    grid_surf = pygame.Surface((GRID_W, GRID_H))
    hud_surf  = pygame.Surface((WIN_W, HUD_H))

    state = 'menu'
    game  = None

    while state != 'quit':

        if state == 'menu':
            action = screen_menu(win, fonts, settings, clock)
            if action == 'play':
                game = Snake(settings); sfx('start',settings); state='playing'
            elif action in ('customise','leaderboard','quit'):
                if action=='customise': screen_customise(win,fonts,settings,clock)
                elif action=='leaderboard': screen_leaderboard(win,fonts,settings,clock)
                else: state='quit'

        elif state == 'playing':
            dt = clock.tick(FPS)
            for ev in pygame.event.get():
                if ev.type==pygame.QUIT: state='quit'; break
                if ev.type==pygame.KEYDOWN:
                    if   ev.key in (pygame.K_UP,   pygame.K_w): game.steer((0,-1))
                    elif ev.key in (pygame.K_DOWN,  pygame.K_s): game.steer((0,1))
                    elif ev.key in (pygame.K_LEFT,  pygame.K_a): game.steer((-1,0))
                    elif ev.key in (pygame.K_RIGHT, pygame.K_d): game.steer((1,0))
                    elif ev.key==pygame.K_p:
                        game.paused=not game.paused; sfx('pause',settings)
                    elif ev.key==pygame.K_r:
                        game=Snake(settings); sfx('start',settings)
                    elif ev.key==pygame.K_m:
                        settings['muted']=not settings['muted']; save_settings(settings)
                        if not settings['muted']: sfx('unmute',settings)
                    elif ev.key==pygame.K_ESCAPE: state='menu'; game=None; break
                    elif ev.key==pygame.K_l:
                        screen_leaderboard(win,fonts,settings,clock)
                    elif ev.key==pygame.K_c:
                        screen_customise(win,fonts,settings,clock)
                        if game: game.cfg=settings

            if state!='playing' or game is None: continue

            result = game.update(dt)
            if result=='eat':     sfx('eat',settings)
            elif result=='levelup': sfx('levelup',settings)
            elif result=='death':
                sfx('death',settings)
                draw_game(win,game,fonts,grid_surf,hud_surf)
                scanlines(win); pygame.display.flip()
                pygame.time.wait(900)
                last = game.score
                if qualifies(last):
                    name = screen_name_entry(win,fonts,settings,last,clock)
                    add_entry(name,last)
                    r = screen_leaderboard(win,fonts,settings,clock,highlight=last)
                else:
                    r = screen_game_over(win,fonts,settings,last,clock)
                if r=='play':
                    game=Snake(settings); sfx('start',settings)
                elif r=='leaderboard':
                    r2=screen_leaderboard(win,fonts,settings,clock)
                    if r2=='play': game=Snake(settings); sfx('start',settings)
                    else: state='menu'; game=None
                elif r=='quit': state='quit'
                else: state='menu'; game=None
                continue

            if game:
                draw_game(win,game,fonts,grid_surf,hud_surf)
                scanlines(win)
                pygame.display.flip()

    save_settings(settings)
    pygame.quit()
    sys.exit()

if __name__ == '__main__':
    main()
