# Preview 운영 절차

이 문서는 Fleetia Bot의 AWS·GitHub 연결, 배포 확인과 실패 복구를 다룹니다. 모든 명령은 bot 저장소 루트에서 실행합니다. 실제 계정 정보와 resource ARN은 로컬 설정 또는 GitHub Actions 변수로 관리하며 문서에 복사하지 않습니다.

## AWS 준비

기존 `star-light.space` Route 53 public hosted zone과 해당 개인 AWS account의 GitHub OIDC provider가 필요합니다. CDK 배포용 운영자 자격 증명은 bot의 제한된 배포 role과 별개입니다.

`cdk.context.json`은 gitignored입니다. 다음 구조의 placeholder를 실제 값으로 바꿔 로컬에서 작성합니다. 이 예시는 그대로 배포할 수 없습니다.

```json
{
  "account": "<AWS_ACCOUNT_ID>",
  "hostedZoneId": "<HOSTED_ZONE_ID>",
  "oidcProviderArn": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com",
  "oidcSubject": "repo:fleetia@<OWNER_ID>/kbo-knit@<REPOSITORY_ID>:ref:refs/heads/main",
  "region": "ap-northeast-2",
  "project": "kbo-knit",
  "domain": "kbo-knit.star-light.space",
  "repository": "fleetia/kbo-knit"
}
```

Node.js 24, pnpm 11.25.0 및 운영자 AWS 인증을 준비한 뒤 다음 순서로 실행합니다. bootstrap 명령의 `FLEETIA_AWS_ACCOUNT_ID`는 확인한 계정 ID를 담은 로컬 환경변수입니다. 이미 bootstrap된 환경에서는 다시 실행할 필요가 없습니다.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm cdk bootstrap "aws://$FLEETIA_AWS_ACCOUNT_ID/us-east-1" "aws://$FLEETIA_AWS_ACCOUNT_ID/ap-northeast-2"
pnpm synth
pnpm cdk diff --all
pnpm cdk deploy --all
```

[infra/app.ts](../infra/app.ts)는 `kbo-knit-preview-certificate`와 `kbo-knit-preview` stack을 구성합니다. 인증서는 CloudFront 요구사항에 맞춰 `us-east-1`에 생성하고 preview stack은 지정 region에 생성합니다. DNS 검증 완료와 두 stack의 완료 상태를 확인합니다. preview stack outputs의 `DeploymentRoleArn` 등은 다음 GitHub 설정에 사용합니다.

## GitHub 연결

GitHub App을 만들고 repository permission **Pull requests: Read and write**를 부여합니다. Metadata 읽기는 GitHub가 기본 부여합니다. App을 대상 KBO 저장소에 설치하고 private key를 생성합니다. webhook server는 사용하지 않습니다. App token은 댓글 작성에만 사용하며 Actions 자체 실행은 caller workflow가 담당합니다.

KBO 저장소의 Actions 설정에 다음 값을 둡니다.

| 종류 | 이름 | 값의 출처 |
| --- | --- | --- |
| Variable | `FLEETIA_BOT_APP_ID` | 설치한 GitHub App ID |
| Secret | `FLEETIA_BOT_PRIVATE_KEY` | 해당 App private key PEM 전체 |
| Variable | `FLEETIA_AWS_ACCOUNT_ID` | 사전 검사에서 기대하는 개인 AWS account |
| Variable | `FLEETIA_AWS_REGION` | preview stack region; 생략 시 `ap-northeast-2` |
| Variable | `FLEETIA_PREVIEW_STACK` | `kbo-knit-preview` |
| Variable | `FLEETIA_PREVIEW_ROLE_ARN` | stack output `DeploymentRoleArn` |

private key를 소스나 artifact에 넣지 않습니다. 로컬 `.pem`, `.env*`, `*.local.json`, `cdk.context.json`은 `.gitignore` 대상입니다. GitHub Packages에서 KBO dependency를 읽을 수 있도록 KBO Actions의 package 접근 권한도 확인합니다.

[caller 예제](../examples/kbo-knit-preview.yml)를 KBO의 `.github/workflows/`에 설치합니다. reusable workflow `uses`의 SHA와 `with.bot-ref`를 **검증한 동일한 40자리 commit SHA**로 바꿉니다. bot 저장소가 먼저 해당 commit을 제공해야 합니다. `main` 같은 이동 가능한 ref를 release pin으로 사용하지 않습니다. bot release를 갱신할 때 두 값을 함께 수정하고 새 caller로 검증합니다.

`oidcSubject`는 필수 context이며 repository 이름만으로 추정하지 않습니다. `gh api repos/fleetia/kbo-knit/actions/oidc/customization/sub`로 실제 `sub_claim_prefix`를 확인하고 `:ref:refs/heads/main`을 붙입니다. [GitHub OIDC 문서](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)에 따르면 2026년 7월 15일 이후 생성되거나 이름·소유자가 변경된 repository는 owner/repository ID가 들어간 subject를 사용합니다. `use_default` 값만 보고 이전 이름 기반 형식이라고 판단하면 안 됩니다. 이전 형식은 실제 prefix가 `repo:fleetia/kbo-knit`일 때만 설정합니다. CDK는 등록한 repository의 `main`에 대한 정확한 두 형식만 허용하며 wildcard·다른 repository·environment subject는 거부합니다.

caller는 기본 branch에서 동작해야 합니다. OIDC trust는 등록된 repository의 `refs/heads/main`에 한정됩니다. caller가 `issue_comment.created`와 `pull_request_target.closed`를 받고, reusable workflow가 사용자·PR·source·명령을 검사합니다. `resolve`는 GitHub run의 `referenced_workflows.sha`와 `bot-ref`가 일치하는지도 확인합니다. App 설치만으로 명령이 활성화되지는 않습니다.

## 사전 검사와 정상 확인

prepare/publish는 자격 증명을 얻은 뒤 다음 조건을 확인하고, 하나라도 맞지 않으면 게시를 진행하지 않습니다.

- STS account와 설정 account 일치, 정확한 preview stack 이름 및 완료 상태.
- stack output의 등록 domain, bucket, CloudFront, certificate, hosted zone 확인.
- CloudFront가 enabled/deployed이고 wildcard alias·certificate·private S3 origin이 예상 구성과 일치.
- 인증서가 발급되었고 wildcard DNS가 해당 distribution을 가리킴.
- S3 bucket 접근 가능, PR source·명령 권한·요청 SHA 및 기존 prefix 소유권 일치.

테스트 API URL은 [project.ts](../src/project.ts)의 공개 build 환경으로 전달됩니다. KBO frontend는 preview branch와 정확한 test origin을 요구합니다. 이 URL을 production API나 직접 API Gateway 주소로 바꾸지 않습니다. API IP allowlist와 테스트 portal의 preview alias/CORS 연결은 Iserlohn이 소유하며 이 stack이 변경하지 않습니다.

열린 같은 저장소 PR에 deploy 댓글을 작성하고 Actions의 resolve/prepare/build/publish와 최종 App 댓글을 확인합니다. build는 등록된 lint/test/build/Storybook script를 실행합니다. publish는 동일 run/attempt의 artifact를 받아 source와 S3 최신 요청을 재검사합니다. 성공 댓글의 요청 SHA와 배포 SHA가 같아야 합니다. 허용된 네트워크에서 실제 preview 페이지와 로그인·동기화를 별도로 확인합니다.

## 실패와 복구

`status`는 S3 상태, 마지막 검증 SHA, 현재 PR head를 비교합니다. building/publishing/deleting 상태가 남으면 마지막 Actions run 결과도 함께 조회합니다. 작업이 취소되거나 build가 실패하면 S3에 진행 상태가 남을 수 있으므로 상태 단어만 보고 실행 중이라고 판단하지 않습니다.

| 상황 | 확인과 복구 |
| --- | --- |
| resolve 미수락 | 사용자 등록, 같은 저장소 PR 여부, 정확한 댓글, caller SHA pin 확인 |
| prepare 실패 | 댓글의 사전 검사 이유와 Actions logs 확인; account/role/stack/DNS/certificate 설정 수정 후 새 deploy 댓글 |
| build 실패 | build logs에서 lint/test/build/Storybook 실패 수정; 새 PR head에 새 deploy 댓글 |
| 요청이 superseded 또는 SHA 변경 | 현재 head와 최근 명령 확인 후 필요한 배포만 새 댓글로 요청 |
| publish 실패 | 파일 일부가 바뀌었을 수 있음; 이전 버전 보장을 가정하지 말고 수정 후 새 deploy로 전체 artifact 재게시 |
| 댓글만 실패 | App 설치·Pull requests 권한·key 확인; 실제 publish 결과를 Actions에서 먼저 확인하고 status 요청 |
| delete 실패 | 공개 파일이나 cache가 남을 수 있음; 원인 해결 후 새 delete 댓글과 공개 index 결과 확인 |

PR 명령 댓글을 수정하거나 삭제하면 재검증에서 거부될 수 있습니다. 재시도는 새 댓글을 권장합니다. 게시된 요청을 Actions 재실행만으로 다시 게시하는 것은 허용되지 않을 수 있습니다.

delete는 branch prefix를 페이지 단위로 삭제하고 CloudFront invalidation 완료를 기다린 뒤 공개 `index.html`이 403/404인지 확인합니다. `_control/` tombstone은 늦게 도착한 이전 배포를 막기 위해 유지합니다. 다른 branch prefix와 공유 API 데이터는 삭제하지 않습니다. 서버 삭제는 이미 설치된 브라우저 ServiceWorker의 오프라인 cache까지 제거하지 않습니다.

이전 hash asset은 일반 게시 때 삭제하지 않으므로 branch 수명 동안 bucket 사용량이 늘 수 있습니다. stack 제거 시 bucket은 `RETAIN` 정책으로 남습니다. `cdk destroy`를 branch 정리 명령으로 사용하지 않습니다.

## 동시 실행과 알려진 한계

prepare/publish/comment의 branch queue는 동시에 AWS 변경이나 댓글 갱신이 실행되지 않게 합니다. `queue: max`는 최대 100개의 pending job을 지원하며 넘으면 추가 job이 취소될 수 있습니다. 순서는 queue에 들어간 시점 기준입니다. [GitHub concurrency 문서](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)를 기준으로 합니다.

최신성은 S3에 수락된 요청 order 기준이며, GitHub queue에서 대기하는 새 명령이 현재 작업을 즉시 중단시키지는 않습니다. status 댓글은 더 최근 결과를 덮지 않도록 보수적으로 생략될 수 있습니다. 최종 댓글은 진행 댓글 종료를 기다리지만 댓글 전달 자체는 배포 성공 조건이 아닙니다.

고정 prefix 갱신은 원자적 전환이나 자동 rollback을 제공하지 않습니다. 게시 성공 검증은 manifest·HTML·일부 JS/CSS 요청에 한정되고 전체 파일·브라우저 상태·test API 가용성을 보증하지 않습니다. API와 데이터는 모든 preview가 공유합니다.

현재 workflow 검증 도구 actionlint 1.7.12는 공식 지원된 `concurrency.queue`를 아직 인식하지 못합니다. 이 버전으로 검사할 때는 해당 오류만 제외하고 나머지를 검증합니다.

```sh
actionlint -ignore 'unexpected key "queue" for "concurrency" section' .github/workflows/*.yml examples/kbo-knit-preview.yml
```
