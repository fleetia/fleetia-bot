<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/icon-dark.svg">
  <img src=".github/assets/icon.svg" alt="Fleetia Bot" width="64" height="64">
</picture>

# Fleetia Bot

Fleetia Bot은 허용된 사용자의 PR 댓글을 받아 KBO Knit의 branch preview를 배포합니다. GitHub Actions가 빌드와 AWS 배포를 실행하고 GitHub App은 진행 상황과 결과 댓글을 작성합니다. 초기 연결과 장애 복구는 [운영 절차](docs/operations.md)를 참고하세요.

## 사용

`fleetia/kbo-knit`의 같은 저장소 PR에서 등록된 사용자가 다음 댓글을 작성합니다. 명령은 댓글 전체와 일치해야 하며 앞뒤 공백은 허용합니다.

| 댓글 | 동작 |
| --- | --- |
| `@fleetia-bot deploy` | 요청 시점 PR head를 검증하고 배포 |
| `@fleetia-bot deploy delete` | 해당 branch의 preview 삭제 |
| `@fleetia-bot status` | 저장된 상태와 현재 PR SHA 비교 |

PR이 닫히면 자동 삭제합니다. 같은 source branch에 열린 PR이 남아 있으면 자동 삭제를 건너뜁니다. 수동 삭제는 이 예외를 적용하지 않습니다. fork PR과 등록되지 않은 사용자의 명령은 배포 대상으로 받지 않습니다.

주소는 `https://<branch-id>.kbo-knit.star-light.space`입니다. branch가 소문자 DNS label이면 그대로 사용하고, 그 밖의 이름은 정규화한 이름과 원본 이름의 hash로 변환합니다. 실제 변환은 [src/commands.ts](src/commands.ts)가 소유합니다.

## 개발

Node.js 24와 pnpm 11.25.0을 사용합니다. 이 저장소 루트에서 실행합니다.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

CI도 같은 검증을 실행하며 AWS 권한이 없습니다. `pnpm bot resolve|prepare|publish|report`는 GitHub event, job outputs 및 단계별 환경변수를 받는 내부 CLI입니다. 운영 요청은 위 PR 댓글로 실행합니다.

## 실행 경계

[preview.yml](.github/workflows/preview.yml)은 요청 해석, 사전 검사, 소스 빌드, 게시를 분리합니다. AWS OIDC는 prepare/publish에만 있습니다. PR 코드를 실행하는 build는 contents/packages 읽기 권한만 받고, checkout에 인증 정보를 남기지 않습니다.

[comment.yml](.github/workflows/comment.yml)은 building, publishing, 최종 상태를 같은 PR 댓글에 기록합니다. GitHub App private key는 이 workflow의 댓글 job에서만 사용하며 AWS 권한은 없습니다. 댓글 실패는 빌드나 게시를 막지 않습니다. 최종 댓글은 진행 댓글 job이 모두 끝난 뒤 실행합니다.

prepare/publish/comment는 같은 branch concurrency group에서 `queue: max`로 직렬 실행됩니다. 배포 최신성은 **S3에 수락된 최신 요청**을 기준으로 검사합니다. 새 명령이 GitHub queue에 들어온 것만으로 진행 중인 작업을 즉시 중단하지 않습니다. queue 진입 순서와 명령 작성 순서는 다를 수 있어 S3의 요청 order와 조건부 쓰기도 함께 사용합니다.

## 배포와 지원 범위

하나의 private S3 bucket과 wildcard CloudFront가 branch prefix를 나눠 제공합니다. CloudFront Function은 hostname을 검증한 뒤 prefix를 붙입니다. 브라우저 asset base와 ServiceWorker 경로를 바꾸지 않습니다. `_control/` 상태는 CloudFront로 공개하지 않습니다.

게시 순서는 일반 파일, HTML, `sw.js`입니다. 이전 hash asset은 유지합니다. 고정 prefix를 갱신하므로 **배포는 원자적이지 않습니다**. 중간 실패 시 일부 새 파일이 공개될 수 있으며 자동 rollback은 없습니다. 성공은 manifest와 실제 HTML 및 일부 JS/CSS의 hash를 확인한 뒤 기록합니다. 이 검증이 전체 브라우저 상호작용이나 로그인 검증을 대신하지는 않습니다.

Preview는 `https://iserlohn-test.star-light.space`의 공유 테스트 API와 데이터를 사용합니다. branch별 API나 DB를 만들지 않습니다. 테스트 API의 IP 제한은 유지되므로 허용된 네트워크에서 로그인과 동기화를 확인해야 합니다. 로그인 alias는 `kbo-knit-preview:<branch-id>`이며 Iserlohn의 테스트 환경에서도 이 alias와 origin을 허용해야 합니다.

현재 등록은 KBO Knit 하나입니다. [src/project.ts](src/project.ts)가 repository, 명령 허용 사용자, domain, 공개 build 환경과 실행할 package script를 정의하고 [src/build.ts](src/build.ts)가 이를 실행합니다. artifact는 KBO의 `dist` 구조와 루트 `index.html`, `sw.js`를 요구합니다. 다른 프로젝트를 추가하려면 등록값뿐 아니라 artifact 검사, workflow upload 경로, infra 및 인증 연동을 함께 검토해야 합니다. 범용 다중 프로젝트 지원으로 해석하지 마세요.

프로젝트 등록, workflow 권한, CLI 계약, infra output 또는 게시·삭제 정책을 바꾸면 이 문서와 운영 절차도 함께 갱신합니다.
