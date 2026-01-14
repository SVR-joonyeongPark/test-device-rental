/**
 * 분기별 신청 기간 관리 모듈 (서버 시간 기반 + 자동 계산)
 */
import { db } from './firebase-config.js';
import {
    collection,
    query,
    where,
    getDocs,
    doc,
    getDoc,
    setDoc,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js';

// ============================================
// 서버 시간 관리
// ============================================
let serverTimeOffset = 0;
let isServerTimeSynced = false;

/**
 * Firebase 서버 시간 동기화
 */
export async function getServerTime() {
    try {
        const timeRef = doc(db, '_serverTime', 'current');
        await setDoc(timeRef, { timestamp: serverTimestamp() });
        const timeDoc = await getDoc(timeRef);
        const data = timeDoc.data();

        if (data && data.timestamp) {
            const serverTime = data.timestamp.toDate();
            const clientTime = new Date();
            serverTimeOffset = serverTime.getTime() - clientTime.getTime();
            isServerTimeSynced = true;

            console.log('서버 시간 동기화 완료');
            console.log('서버 시간:', serverTime.toISOString());
            console.log('시간 차이:', Math.round(serverTimeOffset / 1000), '초');

            return serverTime;
        }
        throw new Error('서버 시간을 가져올 수 없습니다');
    } catch (error) {
        console.error('서버 시간 동기화 실패:', error);
        console.warn('클라이언트 시간을 사용합니다.');
        isServerTimeSynced = false;
        return new Date();
    }
}

/**
 * 현재 서버 시간 추정 (offset 사용)
 */
export function getCurrentServerTime() {
    if (!isServerTimeSynced) {
        return new Date();
    }
    return new Date(Date.now() + serverTimeOffset);
}

export function isTimeSynced() {
    return isServerTimeSynced;
}

export function getServerTimeOffset() {
    return serverTimeOffset;
}

// ============================================
// 분기 자동 계산
// ============================================

/**
 * 분기 정보 계산
 * @param {number} year - 연도
 * @param {number} quarter - 분기 (1-4)
 * @returns {Object} 분기 정보
 */
function calculateQuarterInfo(year, quarter) {
    // 분기별 대여 기간
    const quarterRanges = {
        1: { start: [year, 0, 1], end: [year, 2, 31] },       // 1월 1일 ~ 3월 31일
        2: { start: [year, 3, 1], end: [year, 5, 30] },       // 4월 1일 ~ 6월 30일
        3: { start: [year, 6, 1], end: [year, 8, 30] },       // 7월 1일 ~ 9월 30일
        4: { start: [year, 9, 1], end: [year, 11, 31] }       // 10월 1일 ~ 12월 31일
    };

    // 신청 기간: 분기 시작 2주 전 ~ 분기 시작 후 2주 (총 4주)
    const applyRanges = {
        1: { start: [year - 1, 11, 15], end: [year, 0, 14] },  // 전년 12월 15일 ~ 1월 14일
        2: { start: [year, 2, 15], end: [year, 3, 14] },       // 3월 15일 ~ 4월 14일
        3: { start: [year, 5, 15], end: [year, 6, 14] },       // 6월 15일 ~ 7월 14일
        4: { start: [year, 8, 15], end: [year, 9, 14] }        // 9월 15일 ~ 10월 14일
    };

    const range = quarterRanges[quarter];
    const apply = applyRanges[quarter];

    return {
        quarter: `${year}년 Q${quarter}`,
        applyStart: new Date(apply.start[0], apply.start[1], apply.start[2], 0, 0, 0),
        applyEnd: new Date(apply.end[0], apply.end[1], apply.end[2], 23, 59, 59),
        rentalStart: `${range.start[0]}-${String(range.start[1] + 1).padStart(2, '0')}-${String(range.start[2]).padStart(2, '0')}`,
        rentalEnd: `${range.end[0]}-${String(range.end[1] + 1).padStart(2, '0')}-${String(range.end[2]).padStart(2, '0')}`,
        isActive: true,
        isAutoCalculated: true
    };
}

/**
 * 현재 날짜 기준으로 해당하는 분기 정보 가져오기
 * 신청 기간: 분기 시작 2주 전 ~ 분기 시작 후 2주
 * @param {Date} now - 현재 시간
 * @returns {Object} 현재 또는 다음 분기 정보
 */
function getRelevantPeriod(now) {
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-11
    const day = now.getDate();

    let targetQuarter, targetYear;

    // Q1: 신청 12/15 ~ 1/14, 대여 1/1 ~ 3/31
    // Q2: 신청 3/15 ~ 4/14, 대여 4/1 ~ 6/30
    // Q3: 신청 6/15 ~ 7/14, 대여 7/1 ~ 9/30
    // Q4: 신청 9/15 ~ 10/14, 대여 10/1 ~ 12/31

    if (month === 11 && day >= 15) {
        // 12월 15일 이후: 다음해 Q1 신청 기간
        targetQuarter = 1;
        targetYear = year + 1;
    } else if (month === 0 && day <= 14) {
        // 1월 1일 ~ 14일: Q1 신청 기간 (분기 시작 후 2주)
        targetQuarter = 1;
        targetYear = year;
    } else if (month >= 0 && month <= 1) {
        // 1월 15일 ~ 2월: Q1 대여 중, Q2 신청 대기
        targetQuarter = 2;
        targetYear = year;
    } else if (month === 2 && day < 15) {
        // 3월 1일 ~ 14일: Q1 대여 중, Q2 신청 대기
        targetQuarter = 2;
        targetYear = year;
    } else if (month === 2 && day >= 15) {
        // 3월 15일 이후: Q2 신청 기간
        targetQuarter = 2;
        targetYear = year;
    } else if (month === 3 && day <= 14) {
        // 4월 1일 ~ 14일: Q2 신청 기간 (분기 시작 후 2주)
        targetQuarter = 2;
        targetYear = year;
    } else if (month >= 3 && month <= 4) {
        // 4월 15일 ~ 5월: Q2 대여 중, Q3 신청 대기
        targetQuarter = 3;
        targetYear = year;
    } else if (month === 5 && day < 15) {
        // 6월 1일 ~ 14일: Q2 대여 중, Q3 신청 대기
        targetQuarter = 3;
        targetYear = year;
    } else if (month === 5 && day >= 15) {
        // 6월 15일 이후: Q3 신청 기간
        targetQuarter = 3;
        targetYear = year;
    } else if (month === 6 && day <= 14) {
        // 7월 1일 ~ 14일: Q3 신청 기간 (분기 시작 후 2주)
        targetQuarter = 3;
        targetYear = year;
    } else if (month >= 6 && month <= 7) {
        // 7월 15일 ~ 8월: Q3 대여 중, Q4 신청 대기
        targetQuarter = 4;
        targetYear = year;
    } else if (month === 8 && day < 15) {
        // 9월 1일 ~ 14일: Q3 대여 중, Q4 신청 대기
        targetQuarter = 4;
        targetYear = year;
    } else if (month === 8 && day >= 15) {
        // 9월 15일 이후: Q4 신청 기간
        targetQuarter = 4;
        targetYear = year;
    } else if (month === 9 && day <= 14) {
        // 10월 1일 ~ 14일: Q4 신청 기간 (분기 시작 후 2주)
        targetQuarter = 4;
        targetYear = year;
    } else {
        // 10월 15일 ~ 12월 14일: Q4 대여 중, Q1 신청 대기
        targetQuarter = 1;
        targetYear = year + 1;
    }

    return calculateQuarterInfo(targetYear, targetQuarter);
}

// ============================================
// 신청 기간 관리
// ============================================

/**
 * 현재 활성 분기 가져오기
 * 1. Firestore에서 수동 설정된 기간 확인
 * 2. 없으면 서버 시간 기준으로 자동 계산
 */
export async function getCurrentPeriod() {
    try {
        // 1차: Firestore에서 수동 설정 확인
        const currentRef = doc(db, 'rentalPeriods', 'current');
        const currentSnap = await getDoc(currentRef);

        if (currentSnap.exists()) {
            const data = currentSnap.data();
            if (data.isActive) {
                console.log('Firestore에서 수동 설정된 기간 사용');
                return { id: currentSnap.id, ...data };
            }
        }

        // 2차: isActive=true인 문서 쿼리
        const periodsRef = collection(db, 'rentalPeriods');
        const q = query(periodsRef, where('isActive', '==', true));
        const snapshot = await getDocs(q);

        if (!snapshot.empty) {
            const periodDoc = snapshot.docs[0];
            console.log('Firestore에서 활성 기간 사용');
            return { id: periodDoc.id, ...periodDoc.data() };
        }

        // 3차: 자동 계산
        console.log('Firestore 설정 없음 - 자동 계산 모드');
        const now = getCurrentServerTime();
        const autoCalculated = getRelevantPeriod(now);
        console.log('자동 계산된 분기:', autoCalculated.quarter);
        return autoCalculated;

    } catch (error) {
        console.error('신청 기간 조회 실패:', error);
        // 오류 시에도 자동 계산 시도
        const now = getCurrentServerTime();
        return getRelevantPeriod(now);
    }
}

/**
 * 신청 기간 상태 체크 (서버 시간 기반)
 */
export function checkPeriodStatus(period) {
    if (!period) {
        return 'no_period';
    }

    const now = getCurrentServerTime();

    const applyStart = period.applyStart?.toDate
        ? period.applyStart.toDate()
        : new Date(period.applyStart);
    const applyEnd = period.applyEnd?.toDate
        ? period.applyEnd.toDate()
        : new Date(period.applyEnd);

    console.log('신청 기간 체크 (서버 시간 기준):');
    console.log('- 현재 시간:', now.toLocaleString('ko-KR'));
    console.log('- 신청 시작:', applyStart.toLocaleString('ko-KR'));
    console.log('- 신청 종료:', applyEnd.toLocaleString('ko-KR'));

    if (now < applyStart) {
        return 'before_apply';
    } else if (now >= applyStart && now <= applyEnd) {
        return 'apply_open';
    } else {
        return 'apply_closed';
    }
}

// ============================================
// 포맷팅 함수
// ============================================

export function formatToKST(date) {
    const dateObj = date?.toDate ? date.toDate() : new Date(date);
    return dateObj.toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

export function formatDateToKST(date) {
    const dateObj = date?.toDate ? date.toDate() : new Date(date);
    return dateObj.toLocaleDateString('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

// ============================================
// UI 텍스트 생성
// ============================================

export function getPeriodNoticeText(status, period) {
    if (!period) {
        return { icon: '', text: '신청 기간이 설정되지 않았습니다' };
    }

    const applyStart = formatDateToKST(period.applyStart);
    const applyEnd = formatDateToKST(period.applyEnd);

    switch (status) {
        case 'before_apply':
            return { icon: '', text: `${period.quarter} 신청: ${applyStart} ~ ${applyEnd}` };
        case 'apply_open':
            return { icon: '', text: `${period.quarter} 신청: ${applyStart} ~ ${applyEnd}` };
        case 'apply_closed':
            return { icon: '', text: `${period.quarter} 신청 마감 (${applyEnd})` };
        default:
            return { icon: '', text: '기간 정보 없음' };
    }
}

export function getBannerInfo(status, period) {
    if (!period) return null;

    const applyStart = formatDateToKST(period.applyStart);
    const applyEnd = formatDateToKST(period.applyEnd);
    const rentalStart = formatDateToKST(period.rentalStart);
    const rentalEnd = formatDateToKST(period.rentalEnd);

    const autoNote = period.isAutoCalculated ? ' (자동 계산)' : '';

    switch (status) {
        case 'before_apply':
            return {
                type: 'before-apply',
                icon: '',
                title: `${period.quarter} 신청 시작 전입니다${autoNote}`,
                message: `신청 기간: ${applyStart} ~ ${applyEnd} | 대여 기간: ${rentalStart} ~ ${rentalEnd}`,
                showExtendButton: false
            };
        case 'apply_open':
            return {
                type: 'apply-open',
                icon: '',
                title: `${period.quarter} 신청 진행 중!${autoNote}`,
                message: `신청 기간: ${applyStart} ~ ${applyEnd} | 대여 기간: ${rentalStart} ~ ${rentalEnd}`,
                showExtendButton: true
            };
        case 'apply_closed':
            return {
                type: 'apply-closed',
                icon: '',
                title: `${period.quarter} 신청 기간이 마감되었습니다`,
                message: `신청 기간: ${applyStart} ~ ${applyEnd} (마감됨)`,
                showExtendButton: false
            };
        default:
            return null;
    }
}

// ============================================
// 대여 관련
// ============================================

export async function getUserCurrentRentals(renterName) {
    try {
        const rentalsRef = collection(db, 'rentals');
        const q = query(
            rentalsRef,
            where('renterName', '==', renterName),
            where('status', 'in', ['pending', 'approved'])
        );

        const snapshot = await getDocs(q);
        const rentals = [];
        const now = getCurrentServerTime();

        snapshot.forEach(doc => {
            const data = doc.data();
            if (new Date(data.endDate) >= now) {
                rentals.push({ id: doc.id, ...data });
            }
        });

        return rentals;
    } catch (error) {
        console.error('대여 정보 조회 실패:', error);
        return [];
    }
}

export function getExtendPeriodText(period) {
    if (!period) return '';
    const rentalStart = formatDateToKST(period.rentalStart);
    const rentalEnd = formatDateToKST(period.rentalEnd);
    return `${rentalStart} ~ ${rentalEnd}`;
}
