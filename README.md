# DearU 테스트 단말 대여 시스템

DearU 사내 테스트 단말의 분기별 대여 신청을 편리하게 관리하는 웹 시스템입니다.

## 주요 기능

- **실시간 검색 & 필터링**: 모델명, OS, 상태별로 단말 검색
- **간편한 신청**: 원클릭으로 대여 신청서 작성
- **중복 방지**: Firestore 실시간 체크를 통한 동시 신청 방지
- **현황 다운로드**: 엑셀/Confluence 포맷 지원
- **신청서 양식 다운로드**: 분기별 파일명 자동 생성

## 기술 스택

- **Frontend**: HTML, CSS, Vanilla JavaScript (ES Modules)
- **Backend**: Firebase Firestore (신청 정보 저장)
- **배포**: GitHub Pages
- **라이브러리**: SheetJS (엑셀 생성)

## 사용 방법

### 1. 단말 검색 및 신청
1. 메인 페이지에서 원하는 단말 검색
2. 대여 가능(초록색 테두리) 단말의 "신청서 작성" 버튼 클릭
3. 폼 작성 후 제출

### 2. 상태 구분
- **초록색**: 대여 가능 - 신청 가능
- **회색**: 대여중 - 현재 대여자 정보 표시
- **빨간색**: 사용 불가 - 고장/미지원 등

### 3. 현황 다운로드
1. 헤더의 "현황 다운로드" 버튼 클릭
2. 엑셀, Confluence, 또는 신청서 양식 선택
3. 신청서 양식은 "YYYY년 Q분기 단말 대여 요청서_OOO.xlsx" 형식으로 다운로드

### 4. 신청 기간 안내
- 헤더에 현재 신청 기간 상태가 표시됩니다
- 상태 배너에서 분기별 신청/대여 기간을 확인할 수 있습니다
- 신청 기간 외에는 새로운 대여 신청이 제한됩니다

### 5. 대여 연장
1. 신청 기간 중 상태 배너의 "대여 연장 신청" 버튼 클릭
2. 대여자명 입력 후 검색 버튼 클릭
3. 연장할 단말 선택 후 연장 신청

## 데이터 구조

### 단말 정보 (data/devices.json)
단말 마스터 데이터는 JSON 파일에서 관리합니다.

```json
{
  "devices": [
    {"id": "ES-M144", "type": "phone", "model": "Galaxy S23", "os": "Android", "osVersion": "14", "note": ""},
    {"id": "ES-M041", "type": "phone", "model": "아이폰8", "os": "iOS", "osVersion": "12.0.1", "note": "고장"}
  ]
}
```

| 필드 | 설명 |
|------|------|
| id | 관리번호 |
| type | 단말 타입 (phone, tablet) |
| model | 모델명 |
| os | 운영체제 (iOS, Android) |
| osVersion | OS 버전 |
| note | 비고 (고장, 미지원 등 → 자동으로 사용불가 처리)

### 신청 정보 (Firestore rentals 컬렉션)
대여 신청 내역은 Firebase Firestore에 저장됩니다.

```json
{
  "deviceId": "ES-M144",
  "deviceName": "Galaxy S23",
  "renterName": "디어유",
  "rentalType": "분기 대여",
  "startDate": "2026-01-01",
  "endDate": "2026-03-31",
  "reason": "PUSH 개발 테스트",
  "status": "approved",
  "createdAt": "2026-01-14T10:30:00Z"
}
```

### 단말 상태 (자동 계산)
JSON에는 status 필드가 없으며, 시스템에서 자동으로 계산합니다.

| 상태 | 조건 |
|------|------|
| `available` | note가 비어있고, 유효한 대여가 없는 경우 |
| `rented` | Firestore에 유효한 대여 정보가 있는 경우 |
| `unavailable` | note에 "고장", "미지원", "전원 불량" 포함 시 |

### 단말 타입
- `phone`: 휴대폰
- `tablet`: 태블릿

### 분기별 신청 기간 (Firestore rentalPeriods 컬렉션)
```json
{
  "quarter": "2026 Q1",
  "applyStart": "2025-12-15",
  "applyEnd": "2026-01-14",
  "rentalStart": "2026-01-01",
  "rentalEnd": "2026-03-31",
  "isActive": true
}
```

## Firestore 보안 규칙

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    // devices 컬렉션: 사용 안 함 (JSON 기반)
    match /devices/{deviceId} {
      allow read: if true;
      allow write: if false;
    }

    // rentals 컬렉션: 신청 정보
    match /rentals/{rentalId} {
      allow read: if true;
      allow create: if request.resource.data.renterName is string
                    && request.resource.data.renterName.size() >= 2
                    && request.resource.data.deviceId is string
                    && request.resource.data.startDate is string
                    && request.resource.data.endDate is string;
      allow update: if true;
      allow delete: if false;
    }

    // rentalPeriods 컬렉션: 분기별 신청 기간
    match /rentalPeriods/{periodId} {
      allow read: if true;
      allow write: if false;
    }

    // _serverTime 컬렉션: 서버 시간 동기화용
    match /_serverTime/{docId} {
      allow read: if true;
      allow write: if true;
    }
  }
}
```

## 로컬 개발

### 로컬 서버 실행

```bash
# Python 3
python -m http.server 8000

# Node.js
npx serve

# VS Code Live Server 확장 사용
```

브라우저에서 `http://localhost:8000` 접속

## GitHub Pages 배포

1. GitHub 저장소 > Settings > Pages
2. Source: **Deploy from a branch**
3. Branch: **main** / **/ (root)**
4. Save 클릭
5. 몇 분 후 `https://[username].github.io/test-device-rental/` 에서 확인

## 프로젝트 구조

```
test-device-rental/
├── index.html              # 메인 페이지
├── css/
│   └── style.css           # 스타일시트
├── js/
│   ├── firebase-config.js  # Firebase 설정
│   ├── rental-period.js    # 분기별 신청 기간 관리
│   └── app.js              # 메인 애플리케이션 로직
├── data/
│   └── devices.json        # 단말 마스터 데이터
├── forms/
│   └── 단말대여요청서_템플릿.xlsx  # 신청서 양식
└── README.md               # 프로젝트 설명
```

## 브라우저 지원

- Chrome (권장)
- Firefox
- Safari
- Edge

※ JavaScript가 비활성화된 경우 안내 메시지가 표시됩니다.

## 자동 상태 관리

- 반납 예정일이 지나면 자동으로 대여 가능 상태로 전환
- 별도의 반납 처리 없이 다음 분기 신청 가능

## 디버그 모드

개발 환경(localhost)에서 `Ctrl+Shift+D` 키로 디버그 패널 표시:
- 서버 시간 vs 클라이언트 시간
- 시간 차이
- 현재 신청 기간 상태

## 버전 정보

- v1.0: 최초 릴리즈
  - 단말 대여 신청 시스템
  - 분기별 신청 기간 관리
  - 실시간 중복 신청 방지
  - 엑셀/Confluence/신청서 양식 다운로드
  - 대여 연장 기능

## 문의

시스템 관련 문의는 SVR-joonyeongPark 연락해주세요.
