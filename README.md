# Profile Images

**무료 프로필 이미지 제작 의뢰 · 완성 작품 갤러리 · 프롬프트 공유 게시판**

Cloudflare **Workers + D1 + R2 + Static Assets**로 작동하는 경량 웹서비스입니다. 일반 방문자는 회원가입 없이 의뢰하고 프롬프트를 공유할 수 있으며, 관리자만 완성 이미지를 여러 장 업로드합니다.

> 현재 상태: **실행 가능한 MVP 코드**. Cloudflare 계정의 데이터베이스/버킷/관리자 시크릿을 연결하고 개인정보 운영 안내를 확정해야 공개 배포할 수 있습니다. 이 저장소에 Cloudflare 자격증명은 포함하지 않습니다.

## 포함된 기능

| 경로 | 기능 |
|---|---|
| `/` | 서비스 홈과 최근 작품/프롬프트 |
| `/request` | 의뢰 접수, 참고 이미지 최대 5장 선택 첨부, 공개 동의(기본 미동의) |
| `/track/<token>` | 의뢰 상태·비공개 결과물 확인 및 개별 다운로드 |
| `/gallery` | 관리자가 게시한 공개 작품 목록·검색 |
| `/gallery/<id>` | 한 의뢰의 여러 완성 이미지 다운로드 |
| `/prompts` | 비회원 프롬프트 목록·검색 |
| `/prompts/new` | 비회원 글쓰기, 글 등록 후 관리 링크 제공 |
| `/prompts/manage/<id>#<token>` | 작성자가 본인의 글 삭제 |
| `/admin/login` | 관리자 로그인 |
| `/admin` | 의뢰 목록·상태 |
| `/admin/requests/<id>` | 상태 수정, 결과 이미지 다중 업로드·대표 선정·순서 조정·삭제, 공개 승인 |
| `/admin/prompts` | 게시글 숨김·삭제 |
| `/admin/usage` | 앱 관리 저장량 및 자동 업로드 제한·수동 차단 |

## 1. 사전 준비

1. Cloudflare 계정에서 **D1 Database** `profile-images-db`를 생성합니다.
2. Cloudflare **R2 bucket** `profile-images-files`를 생성합니다. **R2 버킷을 공개하지 마세요.**
3. Cloudflare **Turnstile widget**을 생성하고 공개 사이트 키와 비밀 키를 받습니다.
4. 이 저장소를 로컬에 복제하고 Node.js 22 이상을 설치합니다.

```bash
npm install
npx wrangler login
npx wrangler d1 create profile-images-db
npx wrangler r2 bucket create profile-images-files
```

이미 Cloudflare 대시보드에서 D1/R2를 생성했다면 해당 명령을 반복하지 마세요.

D1 생성 결과의 `database_id`를 `wrangler.jsonc`의 `REPLACE_WITH_YOUR_D1_DATABASE_ID`와 교체합니다. Turnstile 공개 사이트 키는 `wrangler.jsonc`의 `TURNSTILE_SITE_KEY`에 입력합니다.

## 2. 관리자 및 보안 시크릿

**운영 환경:** 다음 명령으로 각 시크릿을 안전하게 등록합니다.

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put TURNSTILE_SECRET
```

- `ADMIN_PASSWORD`: 12자 이상의 강력한 별도 관리자 비밀번호
- `SESSION_SECRET`: 추측하기 어려운 32자 이상의 임의 문자열 (세션 서명 및 요청 제한 키)
- `TURNSTILE_SECRET`: 위젯의 서버 검증 키. 공개 운영에서는 반드시 설정할 것

`ADMIN_PASSWORD`, `SESSION_SECRET`, `TURNSTILE_SECRET`를 GitHub에 커밋하거나 `wrangler.jsonc`의 `vars`에 넣지 마세요.

**로컬 테스트:** `.dev.vars`를 만들어 아래 값을 개발 전용으로 지정합니다. `.dev.vars`는 Git에서 무시됩니다.

```dotenv
ADMIN_PASSWORD="LOCAL_ONLY_CHANGE_ME_123456"
SESSION_SECRET="LOCAL_ONLY_CHANGE_ME_LONG_RANDOM_SECRET_123456"
# Turnstile 위젯을 사용하지 않는 로컬 환경에서는 아래 키 생략 가능
# TURNSTILE_SECRET="..."
```

## 3. DB 마이그레이션과 개발 서버

```bash
npm run db:local
npm run dev
```

로컬 개발 주소는 `http://localhost:8787`입니다. Wrangler는 로컬 R2/D1 에뮬레이션을 사용합니다. 운영 데이터에 영향을 주지 않습니다.

## 4. 실제 배포

```bash
npm run db:remote
npm run deploy
```

출력된 `https://profile-images.<계정명>.workers.dev` 주소에서 작동을 확인합니다. GitHub Actions 자동 배포 워크플로우가 준비되어 있습니다. 아래 설정을 마치고 `CLOUDFLARE_DEPLOY_ENABLED` 변수를 `true`로 바꾸면 `main` 브랜치 변경 시 자동 배포합니다. 최초 설정 전에는 자동 배포가 실행되지 않습니다.

**배포 전 점검:**
- 정식 도메인을 사용할 경우 Turnstile에 해당 호스트 이름을 등록했는지 확인
- 관리자 비밀번호/세션 비밀 키 설정
- 개인정보 안내에 운영자 연락처·보관 기간·삭제 요청 방식을 실제 정책에 맞게 기재
- 의뢰·비공개 파일에 무단 접근할 수 없는지 점검
- R2 월 요청·저장량, Workers/D1 사용량과 Cloudflare 과금 설정 확인

## 5. GitHub Actions로 자동 배포 (권장)

`.github/workflows/cloudflare-deploy.yml`은 `main` 브랜치의 변경을 테스트한 뒤, 명시적으로 배포가 활성화된 경우에만 D1 마이그레이션과 Workers 배포를 실행합니다. 배포 결과의 `/api/config`, `/api/gallery` 응답도 점검합니다.

1. Cloudflare에서 D1 `profile-images-db`, **비공개** R2 버킷 `profile-images-files`, Turnstile 위젯을 만듭니다. 버킷은 공개 주소로 전환하지 마세요.
2. Cloudflare 계정 ID와 Workers 배포 및 D1 마이그레이션에 필요한 최소 권한으로 제한한 API 토큰을 발급합니다.
3. GitHub 저장소 **Settings → Secrets and variables → Actions**의 *Repository secrets*에 아래 다섯 항목을 등록합니다. **절대 대화창이나 소스코드에 입력하지 마세요.**
   - `CLOUDFLARE_API_TOKEN`: Cloudflare API 토큰
   - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare 계정 ID
   - `ADMIN_PASSWORD`: 12자 이상 관리자 비밀번호
   - `SESSION_SECRET`: 32자 이상 암호학적으로 생성한 임의 문자열
   - `TURNSTILE_SECRET`: Turnstile 서버 측 비밀 키
4. 같은 화면의 *Repository variables*에 아래 항목을 등록합니다.
   - `CLOUDFLARE_D1_DATABASE_ID`: 생성된 D1 데이터베이스 ID(UUID)
   - `TURNSTILE_SITE_KEY`: Turnstile 공개 사이트 키
   - `CLOUDFLARE_DEPLOY_ENABLED`: 초기에는 `false`. 모든 값이 올바른지 검토한 뒤 `true`로 변경
5. GitHub **Actions → Test and deploy to Cloudflare → Run workflow**를 선택해 최초 배포합니다. 이후에는 관련 파일을 `main` 브랜치에 푸시하면 테스트와 배포가 자동 실행됩니다.

워크플로우는 D1 ID와 Turnstile 공개 키를 **CI 환경의 임시 Wrangler 설정 파일에만** 넣습니다. 이를 GitHub 저장소에 커밋하지 않습니다. Worker 런타임 비밀 키는 Wrangler Action에서 Cloudflare Secret으로 등록합니다.

**주의:** `CLOUDFLARE_DEPLOY_ENABLED=false`이거나 변수가 없으면 테스트만 실행하고 배포를 건너뜁니다. Cloudflare 계정 연결을 위한 인증은 소유자가 승인해야 하며, R2 활성화 시 결제 수단 등록 및 초과 과금 정책을 확인하세요. 무료 한도 내에서만 사용하도록 의도했지만 외부 트래픽·과금의 절대적 차단을 보증하지는 않습니다.

## 6. 파일 저장 / 무료 한도 보호

- R2 저장량 **7GB 도달 전후부터 비회원 참고 이미지 업로드 차단**
- R2 저장량 **8GB에서 모든 새 이미지 업로드 차단**
- 8GB는 애플리케이션 관리상 설정된 **보수적 운영 한도**입니다. Cloudflare 실제 R2 10GB-month 요금제 한도와 동일하지 않습니다.
- 동시 업로드 시 D1에서 원자적 예약 후 쓰기; 실패 시 파일 삭제 및 예약량 복구
- 관리자 `/admin/usage`에서 수동 업로드 차단 가능
- 참고 이미지는 비공개. 갤러리 이미지는 완료+동의+관리자 게시가 모두 성립해야 접근 가능
- 이미지 형식 검사(JPG·PNG·WEBP), 크기 제한, 비회원 요청 빈도 제한, Turnstile 사용

**반드시 이해해야 할 한계:** 앱의 `used_bytes`는 앱을 통해 저장·삭제한 파일의 합계입니다. 외부에서 버킷에 직접 업로드한 파일이나 R2 내부 과금 측정값과 차이가 날 수 있으며, R2 읽기·쓰기 요청 수와 Workers/D1 한도를 강제로 차단하지는 않습니다. 월 0원 절대 보장책이 아니므로 Cloudflare 실제 사용량/청구 내역을 별도로 점검하세요. 실패 직후 발생한 예외적 불일치도 운영자가 확인해야 합니다.

## 7. 자동 검증

```bash
npm run check
```

Node.js `node:sqlite` 기반 로컬 테스트에서 비회원 의뢰, 프롬프트 등록·삭제, 관리자 게시 및 다운로드, 파일 용량 제한을 확인합니다.

## 프로젝트 구조

```
public/
  index.html       # 웹 페이지 셸
  style.css        # 반응형 스타일
  app.js           # 라우팅·화면·브라우저 인터랙션
src/
  index.js         # Worker API, 권한 및 파일 처리
migrations/
  0001_init.sql    # D1 스키마
 tests/
  api.test.mjs     # 로컬 자동화 검증
wrangler.jsonc     # Cloudflare 바인딩
```

## 개발 범위

이 서비스는 무료·비영리 운영을 전제로 하며 결제, 회원가입, 자체 AI 이미지 생성, 이메일 알림, ZIP 다운로드, 댓글/좋아요는 구현하지 않습니다.