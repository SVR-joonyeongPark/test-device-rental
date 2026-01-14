/**
 * DearU 테스트 단말 대여 시스템 - Firebase 연동 버전
 */
import { db } from './firebase-config.js';
import {
    collection,
    getDocs,
    doc,
    getDoc,
    addDoc,
    updateDoc,
    onSnapshot,
    query,
    where,
    orderBy,
    runTransaction,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js';
import {
    getServerTime,
    getCurrentServerTime,
    isTimeSynced,
    getServerTimeOffset,
    getCurrentPeriod,
    checkPeriodStatus,
    getPeriodNoticeText,
    getBannerInfo,
    getUserCurrentRentals,
    getExtendPeriodText
} from './rental-period.js';

// ============================================
// 전역 상태
// ============================================
let allDevices = [];
let allRentals = [];
let currentDevice = null;
let currentFilters = {
    search: '',
    type: 'all',
    os: 'all',
    status: 'available'  // 기본값: 대여 가능
};
let currentPeriod = null;
let periodStatus = 'no_period';
let selectedExtendRentals = [];
let isManualEntry = false;

// ============================================
// DOM 요소
// ============================================
const elements = {
    deviceGrid: document.getElementById('deviceGrid'),
    loadingSpinner: document.getElementById('loadingSpinner'),
    emptyState: document.getElementById('emptyState'),
    searchInput: document.getElementById('search'),
    osFilterTags: document.getElementById('osFilterTags'),
    statusFilterTags: document.getElementById('statusFilterTags'),
    resetFiltersBtn: document.getElementById('resetFilters'),
    downloadBtn: document.getElementById('downloadBtn'),
    rentalModal: document.getElementById('rentalModal'),
    rentalForm: document.getElementById('rentalForm'),
    downloadModal: document.getElementById('downloadModal'),
    statusDot: document.querySelector('.status-dot'),
    statusText: document.querySelector('.status-text'),
    toast: document.getElementById('toast'),
    // 기간 관련
    periodNotice: document.getElementById('periodNotice'),
    periodText: document.querySelector('.period-text'),
    statusBanner: document.getElementById('statusBanner'),
    extendModal: document.getElementById('extendModal'),
    // 반납/회수 관련
    returnModal: document.getElementById('returnModal'),
    returnForm: document.getElementById('returnForm'),
    returnPassword: document.getElementById('returnPassword'),
    returnPasswordError: document.getElementById('returnPasswordError'),
    returnDeviceName: document.getElementById('returnDeviceName'),
    returnDeviceDetail: document.getElementById('returnDeviceDetail')
};

// ============================================
// 초기화
// ============================================
async function init() {
    showLoading();

    try {
        // 서버 시간 동기화 (가장 먼저 실행)
        await getServerTime();

        // 로컬 JSON 또는 Firestore에서 데이터 로드
        await loadDevices();
        await loadPeriodInfo();
        setupEventListeners();
        setupRealtimeSync();
        setupDebugMode();
        renderDevices();
        hideLoading();
        updateConnectionStatus(true);
    } catch (error) {
        console.error('초기화 오류:', error);
        hideLoading();
        updateConnectionStatus(false);

        // 초기화 실패 시 JSON에서 단말 정보만 로드
        try {
            await loadDevicesFromJSON();
            renderDevices();
        } catch (jsonError) {
            showToast('데이터를 불러오는데 실패했습니다', 'error');
        }
    }
}

// ============================================
// 신청 기간 관리
// ============================================
async function loadPeriodInfo() {
    try {
        currentPeriod = await getCurrentPeriod();
        periodStatus = checkPeriodStatus(currentPeriod);
        updatePeriodNotice();
        updateStatusBanner();
    } catch (error) {
        console.error('신청 기간 정보 로드 실패:', error);
    }
}

function updatePeriodNotice() {
    const notice = getPeriodNoticeText(periodStatus, currentPeriod);
    if (elements.periodText) {
        elements.periodText.textContent = notice.text;
    }
}

function updateStatusBanner() {
    const bannerInfo = getBannerInfo(periodStatus, currentPeriod);

    if (!bannerInfo) {
        elements.statusBanner.style.display = 'none';
        return;
    }

    elements.statusBanner.style.display = 'block';
    elements.statusBanner.className = `status-banner ${bannerInfo.type}`;

    const titleEl = elements.statusBanner.querySelector('.banner-title');
    const messageEl = elements.statusBanner.querySelector('.banner-message');
    const actionsEl = elements.statusBanner.querySelector('.banner-actions');
    if (titleEl) titleEl.textContent = bannerInfo.title;
    if (messageEl) messageEl.textContent = bannerInfo.message;

    // 연장 버튼 표시 여부
    if (actionsEl) {
        if (bannerInfo.showExtendButton) {
            actionsEl.innerHTML = `<button class="btn-extend" id="openExtendBtn">대여 연장 신청</button>`;
            document.getElementById('openExtendBtn').addEventListener('click', openExtendModal);
        } else {
            actionsEl.innerHTML = '';
        }
    }
}

// ============================================
// 데이터 로드
// ============================================
async function loadDevices() {
    // 단말 정보는 항상 JSON에서 로드
    await loadDevicesFromJSON();

    // Firestore에서 대여 정보 로드 후 단말 상태 반영
    try {
        await loadRentals();
        applyRentalStatusToDevices();
    } catch (error) {
        console.error('대여 정보 로드 실패:', error);
    }
}

/**
 * Firestore에서 해당 단말의 유효한 대여가 있는지 체크
 * @param {string} deviceId - 단말 ID
 * @returns {Object|null} 유효한 대여 정보 또는 null
 */
async function checkExistingRental(deviceId) {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = today.toISOString().split('T')[0];

        const rentalsRef = collection(db, 'rentals');
        const q = query(
            rentalsRef,
            where('deviceId', '==', deviceId),
            where('status', 'in', ['pending', 'approved'])
        );

        const snapshot = await getDocs(q);

        for (const docSnap of snapshot.docs) {
            const rental = docSnap.data();
            // 반납일이 오늘 이후인 경우만 유효한 대여
            if (rental.endDate >= todayStr) {
                return rental;
            }
        }

        return null;
    } catch (error) {
        console.error('대여 체크 오류:', error);
        return null;
    }
}

/**
 * 대여 정보를 단말 상태에 반영 (날짜 체크 포함)
 */
function applyRentalStatusToDevices() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    allRentals.forEach(rental => {
        const device = allDevices.find(d => d.id === rental.deviceId);
        if (!device) return;

        // pending, approved 상태인 대여만 처리
        if (rental.status !== 'pending' && rental.status !== 'approved') {
            return;
        }

        const endDate = new Date(rental.endDate);
        endDate.setHours(23, 59, 59, 999);

        // 반납 예정일이 지났으면 회수 대상으로 표시
        if (endDate < today) {
            device.status = 'overdue';
            device.rentedBy = rental.renterName;
            device.rentalType = rental.rentalType;
            device.endDate = rental.endDate;  // 반납 예정일 저장 (며칠 지났는지 표시용)
        } else {
            // 유효한 대여 → 대여중 상태
            device.status = 'rented';
            device.rentedBy = rental.renterName;
            device.rentalType = rental.rentalType;
        }
    });
}

async function loadDevicesFromJSON() {
    const response = await fetch('data/devices.json');
    if (!response.ok) throw new Error('JSON 로드 실패');
    const data = await response.json();

    // status 필드가 없는 경우 기본값 설정
    allDevices = (data.devices || []).map(device => {
        if (!device.status) {
            // note에 고장/미지원 등이 포함된 경우 unavailable, 그 외는 available
            const unavailableKeywords = ['고장', '미지원', '전원 불량'];
            const isUnavailable = device.note && unavailableKeywords.some(keyword =>
                device.note.includes(keyword)
            );
            device.status = isUnavailable ? 'unavailable' : 'available';
        }
        return device;
    });
}

async function loadRentals() {
    try {
        const rentalsRef = collection(db, 'rentals');
        const q = query(rentalsRef, where('status', 'in', ['pending', 'approved']));
        const snapshot = await getDocs(q);

        allRentals = [];
        snapshot.forEach(doc => {
            allRentals.push({ id: doc.id, ...doc.data() });
        });
    } catch (error) {
        console.error('대여 정보 로드 실패:', error);
    }
}

// ============================================
// 실시간 동기화
// ============================================
function setupRealtimeSync() {
    try {
        const devicesRef = collection(db, 'devices');

        onSnapshot(devicesRef, (snapshot) => {
            snapshot.docChanges().forEach((change) => {
                const deviceData = { id: change.doc.id, ...change.doc.data() };

                if (change.type === 'added' || change.type === 'modified') {
                    const index = allDevices.findIndex(d => d.id === deviceData.id);
                    if (index >= 0) {
                        allDevices[index] = deviceData;
                    } else {
                        allDevices.push(deviceData);
                    }
                } else if (change.type === 'removed') {
                    allDevices = allDevices.filter(d => d.id !== deviceData.id);
                }
            });

            renderDevices();
            updateConnectionStatus(true);
        }, (error) => {
            console.error('실시간 동기화 오류:', error);
            updateConnectionStatus(false);
        });

        // rentals 컬렉션 실시간 감시
        const rentalsRef = collection(db, 'rentals');
        const rentalsQuery = query(rentalsRef, where('status', 'in', ['pending', 'approved']));

        onSnapshot(rentalsQuery, (snapshot) => {
            snapshot.docChanges().forEach((change) => {
                if (change.type === 'added') {
                    const rental = change.doc.data();
                    // 새 신청 알림 (본인 신청 제외)
                    if (!snapshot.metadata.hasPendingWrites) {
                        console.log('새 신청:', rental);
                    }
                }
            });
        });

    } catch (error) {
        console.error('실시간 동기화 설정 실패:', error);
    }
}

// ============================================
// 렌더링
// ============================================
function renderDevices() {
    const filteredDevices = filterDevices(allDevices);

    // 상태 순서: 회수 대상 → 대여 가능 → 신청중 → 대여중 → 사용 불가
    const statusOrder = {
        'overdue': 0,
        'available': 1,
        'pending': 2,
        'rented': 3,
        'unavailable': 4
    };

    const sortedDevices = [...filteredDevices].sort((a, b) => {
        const orderA = statusOrder[a.status] !== undefined ? statusOrder[a.status] : 99;
        const orderB = statusOrder[b.status] !== undefined ? statusOrder[b.status] : 99;
        return orderA - orderB;
    });

    if (sortedDevices.length === 0) {
        elements.deviceGrid.innerHTML = '';
        elements.deviceGrid.classList.add('hidden');
        elements.emptyState.style.display = 'block';
    } else {
        elements.emptyState.style.display = 'none';
        elements.deviceGrid.classList.remove('hidden');
        elements.deviceGrid.innerHTML = sortedDevices.map(device => createDeviceCard(device)).join('');
        bindCardEvents();
    }

    updateDeviceStats();
}

function createDeviceCard(device) {
    const typeIcon = getTypeIcon(device.type);
    const typeName = getTypeName(device.type);
    const statusInfo = getStatusInfo(device);
    const isAvailable = device.status === 'available';
    const isRented = device.status === 'rented' || device.status === 'pending';
    const isOverdue = device.status === 'overdue';

    let renterInfo = '';
    let rentalPeriodInfo = '';
    let overdueInfo = '';

    if (device.rentedBy) {
        renterInfo = `<p class="device-renter">대여자: ${device.rentedBy}</p>`;

        // 대여 기간 정보 찾기
        const rental = allRentals.find(r => r.deviceId === device.id);
        if (rental && rental.startDate && rental.endDate) {
            const startDate = formatDateShort(rental.startDate);
            const endDate = formatDateShort(rental.endDate);
            rentalPeriodInfo = `<p class="device-rental-period">${startDate} ~ ${endDate}</p>`;
        }

        // 회수 대상인 경우 며칠 지연됐는지 표시
        if (isOverdue && device.endDate) {
            const daysOverdue = calculateDaysOverdue(device.endDate);
            overdueInfo = `<p class="device-overdue-info">${daysOverdue}일 지연</p>`;
        }
    }

    let noteInfo = '';
    if (device.note) {
        noteInfo = `<p class="device-note">${device.note}</p>`;
    }

    // 버튼 결정: 대여중/회수대상이면 반납 버튼, 대여 가능이면 신청 버튼
    let footerButton = '';
    if (isRented || isOverdue) {
        const buttonClass = isOverdue ? 'btn-return btn-overdue' : 'btn-return';
        const buttonText = isOverdue ? '회수 처리' : '반납 처리';
        footerButton = `
            <button class="${buttonClass}" data-device-id="${device.id}">
                ${buttonText}
            </button>
        `;
    } else if (isAvailable) {
        footerButton = `
            <button class="btn-apply" data-device-id="${device.id}">
                신청서 작성
            </button>
        `;
    } else {
        footerButton = `
            <button class="btn-apply" data-device-id="${device.id}" disabled>
                신청 불가
            </button>
        `;
    }

    return `
        <article class="device-card status-${device.status}" data-device-id="${device.id}">
            <div class="card-header">
                <span class="device-id">${device.id}</span>
                <span class="device-type-badge type-${device.type}">${typeName}</span>
            </div>
            <div class="card-body">
                <h3 class="device-model">${device.model}</h3>
                <p class="device-os">${device.os} ${device.osVersion}</p>
                <div class="status-badge status-${device.status}">
                    ${statusInfo.text}
                </div>
                ${renterInfo}
                ${rentalPeriodInfo}
                ${overdueInfo}
                ${noteInfo}
            </div>
            <div class="card-footer">
                ${footerButton}
            </div>
        </article>
    `;
}

function formatDateShort(dateStr) {
    const date = new Date(dateStr);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}/${day}`;
}

function calculateDaysOverdue(endDateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endDate = new Date(endDateStr);
    endDate.setHours(0, 0, 0, 0);
    const diffTime = today - endDate;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
}

function bindCardEvents() {
    // 신청 버튼 클릭
    document.querySelectorAll('.btn-apply:not([disabled])').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const deviceId = btn.dataset.deviceId;
            openRentalModal(deviceId);
        });
    });

    // 대여 가능 카드 클릭
    document.querySelectorAll('.device-card.status-available').forEach(card => {
        card.addEventListener('click', (e) => {
            if (!e.target.classList.contains('btn-apply')) {
                const deviceId = card.dataset.deviceId;
                openRentalModal(deviceId);
            }
        });
    });

    // 반납/회수 버튼 클릭
    document.querySelectorAll('.btn-return').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const deviceId = btn.dataset.deviceId;
            const device = allDevices.find(d => d.id === deviceId);
            const rental = allRentals.find(r => r.deviceId === deviceId &&
                (r.status === 'pending' || r.status === 'approved'));

            if (device && rental) {
                openReturnModal(rental, device);
            }
        });
    });
}

// ============================================
// 필터링
// ============================================
function filterDevices(devices) {
    return devices.filter(device => {
        // 검색어 필터
        if (currentFilters.search) {
            const searchTerm = currentFilters.search.toLowerCase();
            const matchModel = device.model.toLowerCase().includes(searchTerm);
            const matchId = device.id.toLowerCase().includes(searchTerm);
            if (!matchModel && !matchId) return false;
        }

        // 단말 타입 필터
        if (currentFilters.type !== 'all' && device.type !== currentFilters.type) {
            return false;
        }

        // OS 필터
        if (currentFilters.os !== 'all' && device.os !== currentFilters.os) {
            return false;
        }

        // 상태 필터
        if (currentFilters.status !== 'all' && device.status !== currentFilters.status) {
            return false;
        }

        return true;
    });
}

function resetFilters() {
    currentFilters = { search: '', type: 'all', os: 'all', status: 'available' };
    elements.searchInput.value = '';

    // OS 태그 초기화
    elements.osFilterTags.querySelectorAll('.os-tag').forEach(tag => {
        tag.classList.toggle('active', tag.dataset.os === 'all');
    });

    // 상태 태그 초기화 (대여 가능이 기본)
    elements.statusFilterTags.querySelectorAll('.status-tag').forEach(tag => {
        tag.classList.toggle('active', tag.dataset.status === 'available');
    });

    renderDevices();
}

// ============================================
// 대여 신청 모달
// ============================================

// 직접 입력 모달 열기
function openManualEntryModal() {
    // 신청 기간 체크
    if (periodStatus !== 'apply_open') {
        if (periodStatus === 'before_apply') {
            showToast('신청 기간이 아직 시작되지 않았습니다', 'warning');
        } else if (periodStatus === 'apply_closed') {
            showToast('신청 기간이 마감되었습니다', 'warning');
        } else {
            showToast('현재 신청 기간이 설정되지 않았습니다', 'warning');
        }
        return;
    }

    isManualEntry = true;
    currentDevice = null;

    // 기존 단말 정보 숨기고 직접 입력 필드 표시
    document.getElementById('selectedDeviceInfo').style.display = 'none';
    document.getElementById('manualDeviceEntry').style.display = 'block';

    // 직접 입력 필드 초기화
    document.getElementById('manualDeviceId').value = '';
    document.getElementById('manualModel').value = '';
    document.getElementById('manualOs').value = '';
    document.getElementById('manualOsVersion').value = '';

    // 날짜 기본값 설정 (분기 시작일 ~ 분기 종료일)
    const today = new Date().toISOString().split('T')[0];
    const startDateInput = document.getElementById('startDate');
    const endDateInput = document.getElementById('endDate');

    // 현재 분기 정보가 있으면 분기 날짜 사용, 없으면 기본값
    if (currentPeriod && currentPeriod.rentalStart && currentPeriod.rentalEnd) {
        startDateInput.value = currentPeriod.rentalStart;
        endDateInput.value = currentPeriod.rentalEnd;
        // 분기 범위 내에서만 선택 가능 (분기 시작일 ~ 분기 종료일)
        startDateInput.min = currentPeriod.rentalStart;
        startDateInput.max = currentPeriod.rentalEnd;
        endDateInput.min = currentPeriod.rentalStart;
        endDateInput.max = currentPeriod.rentalEnd;
    } else {
        startDateInput.value = today;
        const threeMonthsLater = new Date();
        threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3);
        endDateInput.value = threeMonthsLater.toISOString().split('T')[0];
        startDateInput.min = today;
        endDateInput.min = today;
    }

    // 폼 초기화
    document.getElementById('renterName').value = '';
    document.querySelectorAll('input[name="rentalType"]').forEach(r => r.checked = false);
    document.getElementById('reason').value = '';
    document.getElementById('reasonCount').textContent = '0';
    clearErrors();

    // 모달 표시
    elements.rentalModal.classList.add('active');
    document.body.style.overflow = 'hidden';

    setTimeout(() => {
        document.getElementById('manualDeviceId').focus();
    }, 100);
}

function openRentalModal(deviceId) {
    // 신청 기간 체크
    if (periodStatus !== 'apply_open') {
        if (periodStatus === 'before_apply') {
            showToast('신청 기간이 아직 시작되지 않았습니다', 'warning');
        } else if (periodStatus === 'apply_closed') {
            showToast('신청 기간이 마감되었습니다', 'warning');
        } else {
            showToast('현재 신청 기간이 설정되지 않았습니다', 'warning');
        }
        return;
    }

    // 직접 입력 모드 해제
    isManualEntry = false;
    document.getElementById('selectedDeviceInfo').style.display = 'block';
    document.getElementById('manualDeviceEntry').style.display = 'none';

    currentDevice = allDevices.find(d => d.id === deviceId);

    if (!currentDevice || currentDevice.status !== 'available') {
        showToast('대여 가능한 단말이 아닙니다', 'error');
        return;
    }

    // 선택된 단말 정보 표시
    const deviceInfo = document.getElementById('selectedDeviceInfo');
    deviceInfo.innerHTML = `
        <div class="selected-device-title">선택된 단말</div>
        <div class="selected-device-info">${currentDevice.id} - ${currentDevice.model}</div>
        <div class="selected-device-sub">${currentDevice.os} ${currentDevice.osVersion}</div>
    `;

    // 날짜 기본값 설정 (분기 시작일 ~ 분기 종료일)
    const today = new Date().toISOString().split('T')[0];
    const startDateInput = document.getElementById('startDate');
    const endDateInput = document.getElementById('endDate');

    // 현재 분기 정보가 있으면 분기 날짜 사용, 없으면 기본값
    if (currentPeriod && currentPeriod.rentalStart && currentPeriod.rentalEnd) {
        startDateInput.value = currentPeriod.rentalStart;
        endDateInput.value = currentPeriod.rentalEnd;
        // 분기 범위 내에서만 선택 가능 (분기 시작일 ~ 분기 종료일)
        startDateInput.min = currentPeriod.rentalStart;
        startDateInput.max = currentPeriod.rentalEnd;
        endDateInput.min = currentPeriod.rentalStart;
        endDateInput.max = currentPeriod.rentalEnd;
    } else {
        startDateInput.value = today;
        const threeMonthsLater = new Date();
        threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3);
        endDateInput.value = threeMonthsLater.toISOString().split('T')[0];
        startDateInput.min = today;
        endDateInput.min = today;
    }

    // 폼 초기화
    document.getElementById('renterName').value = '';
    document.querySelectorAll('input[name="rentalType"]').forEach(r => r.checked = false);
    document.getElementById('reason').value = '';
    document.getElementById('reasonCount').textContent = '0';
    clearErrors();

    // 모달 표시
    elements.rentalModal.classList.add('active');
    document.body.style.overflow = 'hidden';

    setTimeout(() => {
        document.getElementById('renterName').focus();
    }, 100);
}

function closeRentalModal() {
    elements.rentalModal.classList.remove('active');
    document.body.style.overflow = '';
    currentDevice = null;
    isManualEntry = false;
    // UI 초기화
    document.getElementById('selectedDeviceInfo').style.display = 'block';
    document.getElementById('manualDeviceEntry').style.display = 'none';
}

async function handleFormSubmit(e) {
    e.preventDefault();

    // 연속 클릭 방지
    if (isSubmitLocked('rental')) {
        console.log('Rental submit is locked - preventing duplicate submission');
        return;
    }

    if (!validateForm()) return;

    setSubmitLock('rental', 3000);  // 3초간 중복 제출 방지

    const submitBtn = document.getElementById('submitBtn');
    submitBtn.classList.add('loading');
    submitBtn.disabled = true;

    // 서버 시간 사용
    const serverTime = getCurrentServerTime();

    let formData;

    if (isManualEntry) {
        // 직접 입력 모드
        const deviceId = document.getElementById('manualDeviceId').value.trim();
        const model = document.getElementById('manualModel').value.trim();
        const os = document.getElementById('manualOs').value;
        const osVersion = document.getElementById('manualOsVersion').value.trim();

        formData = {
            deviceId: deviceId,
            deviceName: model,
            deviceType: 'phone', // 기본값
            os: os,
            osVersion: osVersion,
            renterName: document.getElementById('renterName').value.trim(),
            rentalType: document.querySelector('input[name="rentalType"]:checked').value,
            startDate: document.getElementById('startDate').value,
            endDate: document.getElementById('endDate').value,
            reason: document.getElementById('reason').value.trim(),
            status: 'approved',
            isManualEntry: true, // 직접 입력 표시
            createdAt: serverTime.toISOString(),
            updatedAt: serverTime.toISOString(),
            createdAtTimestamp: serverTimestamp()
        };
    } else {
        // 기존 단말 선택 모드
        formData = {
            deviceId: currentDevice.id,
            deviceName: currentDevice.model,
            deviceType: currentDevice.type,
            os: currentDevice.os,
            osVersion: currentDevice.osVersion,
            renterName: document.getElementById('renterName').value.trim(),
            rentalType: document.querySelector('input[name="rentalType"]:checked').value,
            startDate: document.getElementById('startDate').value,
            endDate: document.getElementById('endDate').value,
            reason: document.getElementById('reason').value.trim(),
            status: 'approved',
            createdAt: serverTime.toISOString(),
            updatedAt: serverTime.toISOString(),
            createdAtTimestamp: serverTimestamp()
        };
    }

    try {
        if (isManualEntry) {
            // 직접 입력: 신규 단말 신청
            // Firestore에서 이미 대여 중인지 실시간 체크
            const existingRental = await checkExistingRental(formData.deviceId);
            if (existingRental) {
                throw new Error(`이미 ${existingRental.renterName}님이 대여 중입니다`);
            }

            // Firestore에 신청 정보 저장
            const docRef = await addDoc(collection(db, 'rentals'), formData);
            formData.id = docRef.id;  // 문서 ID 저장

            // 로컬 상태 업데이트 (화면 표시용)
            if (existingDevice) {
                existingDevice.status = 'rented';
                existingDevice.rentedBy = formData.renterName;
                existingDevice.rentalType = formData.rentalType;
            } else {
                // 신규 단말 추가 (로컬)
                allDevices.push({
                    id: formData.deviceId,
                    type: formData.deviceType,
                    model: formData.deviceName,
                    os: formData.os,
                    osVersion: formData.osVersion,
                    status: 'rented',
                    rentedBy: formData.renterName,
                    rentalType: formData.rentalType,
                    note: '직접 입력으로 추가됨'
                });
            }
            allRentals.push(formData);

            showToast('직접 입력 신청이 완료되었습니다!', 'success');
        } else {
            // 기존 단말 선택
            const device = allDevices.find(d => d.id === currentDevice.id);
            if (!device) {
                throw new Error('단말을 찾을 수 없습니다');
            }

            // Firestore에서 이미 대여 중인지 실시간 체크 (중복 신청 방지)
            const existingRental = await checkExistingRental(currentDevice.id);
            if (existingRental) {
                throw new Error(`이미 ${existingRental.renterName}님이 대여 중입니다`);
            }

            // Firestore에 신청 정보 저장
            const docRef = await addDoc(collection(db, 'rentals'), formData);
            formData.id = docRef.id;  // 문서 ID 저장

            // 로컬 상태 업데이트 (화면 표시용)
            device.status = 'rented';
            device.rentedBy = formData.renterName;
            device.rentalType = formData.rentalType;
            allRentals.push(formData);

            showToast('신청이 완료되었습니다!', 'success');
        }

        // 화면 갱신
        renderDevices();
        closeRentalModal();

    } catch (error) {
        console.error('신청 오류:', error);
        showToast(error.message || '신청 중 오류가 발생했습니다', 'error');
    } finally {
        submitBtn.classList.remove('loading');
        submitBtn.disabled = false;
    }
}

function validateForm() {
    clearErrors();
    let isValid = true;

    // 직접 입력 모드일 때 추가 검증
    if (isManualEntry) {
        const deviceId = document.getElementById('manualDeviceId').value.trim();
        const model = document.getElementById('manualModel').value.trim();
        const os = document.getElementById('manualOs').value;
        const osVersion = document.getElementById('manualOsVersion').value.trim();

        if (!deviceId) {
            showError('manualDeviceId', '관리번호를 입력해주세요');
            isValid = false;
        }

        if (!model) {
            showError('manualModel', '모델명을 입력해주세요');
            isValid = false;
        }

        if (!os) {
            showError('manualOs', 'OS를 선택해주세요');
            isValid = false;
        }

        if (!osVersion) {
            showError('manualOsVersion', 'OS 버전을 입력해주세요');
            isValid = false;
        }
    }

    const renterName = document.getElementById('renterName').value.trim();
    const rentalType = document.querySelector('input[name="rentalType"]:checked');
    const startDate = document.getElementById('startDate').value;
    const endDate = document.getElementById('endDate').value;

    // 대여자명 검사
    if (renterName.length < 2) {
        showError('renterName', '대여자명은 2자 이상이어야 합니다');
        isValid = false;
    }

    // 대여 구분 검사
    if (!rentalType) {
        document.getElementById('rentalTypeError').textContent = '대여 구분을 선택해주세요';
        isValid = false;
    }

    // 날짜 검사 (분기 기준)
    const start = new Date(startDate);
    const end = new Date(endDate);
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);

    if (currentPeriod && currentPeriod.rentalStart && currentPeriod.rentalEnd) {
        const periodStart = new Date(currentPeriod.rentalStart);
        const periodEnd = new Date(currentPeriod.rentalEnd);
        periodStart.setHours(0, 0, 0, 0);
        periodEnd.setHours(0, 0, 0, 0);

        if (start < periodStart) {
            showError('startDate', `대여 예정일은 분기 시작일(${currentPeriod.rentalStart}) 이후여야 합니다`);
            isValid = false;
        }

        if (start > periodEnd) {
            showError('startDate', `대여 예정일은 분기 종료일(${currentPeriod.rentalEnd}) 이전이어야 합니다`);
            isValid = false;
        }

        if (end > periodEnd) {
            showError('endDate', `반납 예정일은 분기 종료일(${currentPeriod.rentalEnd})을 넘을 수 없습니다`);
            isValid = false;
        }
    }

    if (end <= start) {
        showError('endDate', '반납 예정일은 대여 예정일 이후여야 합니다');
        isValid = false;
    }

    return isValid;
}

function showError(fieldId, message) {
    const field = document.getElementById(fieldId);
    const errorEl = document.getElementById(fieldId + 'Error');
    if (field) field.classList.add('error');
    if (errorEl) errorEl.textContent = message;
}

function clearErrors() {
    document.querySelectorAll('.error').forEach(el => el.classList.remove('error'));
    document.querySelectorAll('.error-message').forEach(el => el.textContent = '');
}

// ============================================
// 다운로드 기능
// ============================================

/**
 * 현재 날짜를 기준으로 연도와 분기를 계산하여 파일명 생성
 * @returns {string} 형식: "YYYY년 Q분기 단말 대여 요청서_OOO.xlsx"
 */
function generateTemplateFileName() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1; // 0-indexed

    // 분기 계산: 1~3월: 1분기, 4~6월: 2분기, 7~9월: 3분기, 10~12월: 4분기
    const quarter = Math.ceil(month / 3);

    return `${year}년 ${quarter}분기 단말 대여 요청서_OOO.xlsx`;
}

function openDownloadModal() {
    // 템플릿 파일명 미리보기 업데이트
    const templateFileNameEl = document.getElementById('templateFileName');
    if (templateFileNameEl) {
        templateFileNameEl.textContent = generateTemplateFileName();
    }

    elements.downloadModal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeDownloadModal() {
    elements.downloadModal.classList.remove('active');
    document.body.style.overflow = '';
}

async function downloadAsExcel() {
    try {
        showToast('엑셀 파일을 준비 중입니다...', 'info');

        // 최신 대여 정보 로드
        await loadRentals();

        // 현재 표시된 단말 데이터 (필터링 적용)
        const filteredDevices = filterDevices(allDevices);

        // 대여 중인 단말만 필터
        const rentedDevices = filteredDevices.filter(d =>
            d.status === 'rented' || d.status === 'pending'
        );

        if (rentedDevices.length === 0) {
            showToast('다운로드할 대여 데이터가 없습니다', 'warning');
            return;
        }

        // 엑셀 데이터 준비 (대여 정보 매칭)
        const data = rentedDevices.map((device, index) => {
            // 해당 단말의 대여 정보 찾기
            const rental = allRentals.find(r => r.deviceId === device.id) || {};

            // 날짜 포맷팅
            const formatDate = (dateStr) => {
                if (!dateStr) return '';
                const date = new Date(dateStr);
                return date.toLocaleDateString('ko-KR');
            };

            return {
                'NO.': index + 1,
                '관리번호': device.id,
                '모델명': device.model,
                'OS ver.': `${device.os} ${device.osVersion}`,
                '대여자': device.rentedBy || '',
                '대여구분': device.rentalType || '',
                '대여시작': formatDate(rental.startDate),
                '대여종료': formatDate(rental.endDate),
                '신청일자': formatDate(rental.createdAt),
                '상태': device.status === 'pending' ? '신청중' : '대여중',
                '사유': rental.reason || '',
                '비고': device.note || ''
            };
        });

        // SheetJS로 엑셀 생성
        const ws = XLSX.utils.json_to_sheet(data);

        // 컬럼 너비 설정
        ws['!cols'] = [
            { wch: 5 },   // NO.
            { wch: 12 },  // 관리번호
            { wch: 20 },  // 모델명
            { wch: 15 },  // OS ver.
            { wch: 10 },  // 대여자
            { wch: 10 },  // 대여구분
            { wch: 12 },  // 대여시작
            { wch: 12 },  // 대여종료
            { wch: 12 },  // 신청일자
            { wch: 8 },   // 상태
            { wch: 20 },  // 사유
            { wch: 15 }   // 비고
        ];

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '단말대여현황');

        // 파일명 생성
        const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
        XLSX.writeFile(wb, `단말대여현황_${date}.xlsx`);

        showToast('엑셀 파일이 다운로드되었습니다', 'success');
        closeDownloadModal();

    } catch (error) {
        console.error('엑셀 다운로드 오류:', error);
        showToast('다운로드 중 오류가 발생했습니다', 'error');
    }
}

async function downloadAsConfluence() {
    try {
        // 최신 대여 정보 로드
        await loadRentals();

        const filteredDevices = filterDevices(allDevices);
        const rentedDevices = filteredDevices.filter(d =>
            d.status === 'rented' || d.status === 'pending'
        );

        if (rentedDevices.length === 0) {
            showToast('다운로드할 대여 데이터가 없습니다', 'warning');
            return;
        }

        // 날짜 포맷팅 함수
        const formatDate = (dateStr) => {
            if (!dateStr) return '';
            const date = new Date(dateStr);
            return date.toLocaleDateString('ko-KR');
        };

        // Confluence Wiki Markup 테이블 생성
        let table = '|| NO. || 관리번호 || 모델명 || OS ver. || 대여자 || 대여구분 || 대여기간 || 신청일자 || 상태 || 비고 ||\n';

        rentedDevices.forEach((device, index) => {
            // 해당 단말의 대여 정보 찾기
            const rental = allRentals.find(r => r.deviceId === device.id) || {};

            const status = device.status === 'pending' ? '신청중' : '대여중';
            const startDate = formatDate(rental.startDate);
            const endDate = formatDate(rental.endDate);
            const rentalPeriod = startDate && endDate ? `${startDate} ~ ${endDate}` : '';
            const createdAt = formatDate(rental.createdAt);

            table += `| ${index + 1} | ${device.id} | ${device.model} | `;
            table += `${device.os} ${device.osVersion} | ${device.rentedBy || ''} | `;
            table += `${device.rentalType || ''} | ${rentalPeriod} | ${createdAt} | `;
            table += `${status} | ${device.note || ''} |\n`;
        });

        // UTF-8 BOM 추가
        const BOM = '\uFEFF';
        const blob = new Blob([BOM + table], { type: 'text/plain;charset=utf-8' });

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
        a.download = `confluence_table_${date}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('Confluence 테이블이 다운로드되었습니다', 'success');
        closeDownloadModal();

    } catch (error) {
        console.error('Confluence 다운로드 오류:', error);
        showToast('다운로드 중 오류가 발생했습니다', 'error');
    }
}

/**
 * 단말 대여 요청서 템플릿 다운로드
 * 원본 파일을 동적으로 생성된 파일명으로 다운로드
 */
async function downloadTemplate() {
    try {
        showToast('신청서 양식을 다운로드 중입니다...', 'info');

        // 원본 템플릿 파일 fetch
        const response = await fetch('forms/단말대여요청서_템플릿.xlsx');

        if (!response.ok) {
            throw new Error('템플릿 파일을 찾을 수 없습니다');
        }

        const blob = await response.blob();

        // 동적 파일명 생성
        const fileName = generateTemplateFileName();

        // 다운로드 실행
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('신청서 양식이 다운로드되었습니다', 'success');
        closeDownloadModal();

    } catch (error) {
        console.error('템플릿 다운로드 오류:', error);
        showToast('템플릿 다운로드 중 오류가 발생했습니다', 'error');
    }
}

// ============================================
// 대여 연장 모달
// ============================================
async function openExtendModal() {
    selectedExtendRentals = [];

    // 연장 기간 표시
    const periodText = getExtendPeriodText(currentPeriod);
    document.getElementById('extendPeriodText').textContent = periodText;

    // 입력 필드 초기화
    document.getElementById('extendRenterName').value = '';

    // 폼 숨기기
    document.getElementById('extendForm').style.display = 'none';
    document.getElementById('noRentals').style.display = 'none';
    document.getElementById('currentRentals').innerHTML = '';

    elements.extendModal.classList.add('active');
    document.body.style.overflow = 'hidden';

    setTimeout(() => {
        document.getElementById('extendRenterName').focus();
    }, 100);
}

function closeExtendModal() {
    elements.extendModal.classList.remove('active');
    document.body.style.overflow = '';
    selectedExtendRentals = [];
}

// ============================================
// 반납/회수 모달
// ============================================
let currentReturnRental = null;

function openReturnModal(rental, device) {
    currentReturnRental = rental;

    // 단말 정보 표시
    elements.returnDeviceName.textContent = `${device.id} - ${device.model}`;
    elements.returnDeviceDetail.textContent = `대여자: ${rental.renterName} | ${device.os} ${device.osVersion}`;

    // 폼 초기화
    elements.returnPassword.value = '';
    elements.returnPasswordError.textContent = '';

    elements.returnModal.classList.add('active');
    document.body.style.overflow = 'hidden';

    setTimeout(() => {
        elements.returnPassword.focus();
    }, 100);
}

function closeReturnModal() {
    elements.returnModal.classList.remove('active');
    document.body.style.overflow = '';
    currentReturnRental = null;
}

async function verifyAdminPassword(inputPassword) {
    try {
        // Realtime Database 동적 import (필요할 때만 연결)
        const { getDatabase, ref, get } = await import('https://www.gstatic.com/firebasejs/12.7.0/firebase-database.js');
        const { app } = await import('./firebase-config.js');

        const rtdb = getDatabase(app);
        const snapshot = await get(ref(rtdb, 'admin/passwordHash'));

        if (!snapshot.exists()) {
            console.error('Password hash not found in Realtime Database');
            return false;
        }

        const storedHash = snapshot.val();

        // 입력된 비밀번호를 SHA-256으로 해시
        const encoder = new TextEncoder();
        const data = encoder.encode(inputPassword);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const inputHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        return inputHash === storedHash;
    } catch (error) {
        console.error('Password verification failed:', error);
        return false;
    }
}

async function handleReturnSubmit(e) {
    e.preventDefault();

    // 연속 클릭 방지
    if (isSubmitLocked('return')) {
        console.log('Return submit is locked - preventing duplicate submission');
        return;
    }

    if (!currentReturnRental) return;

    const password = elements.returnPassword.value;
    const submitBtn = document.getElementById('returnSubmitBtn');

    if (!password) {
        elements.returnPasswordError.textContent = '비밀번호를 입력하세요';
        return;
    }

    setSubmitLock('return', 3000);  // 3초간 중복 제출 방지

    submitBtn.classList.add('loading');
    submitBtn.disabled = true;
    elements.returnPasswordError.textContent = '';

    try {
        // 비밀번호 검증
        const isValid = await verifyAdminPassword(password);

        if (!isValid) {
            elements.returnPasswordError.textContent = '비밀번호가 일치하지 않습니다';
            return;
        }

        // Firestore에서 대여 기록 삭제
        const { deleteDoc, doc } = await import('https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js');
        const deletedRentalId = currentReturnRental.id;
        const deletedDeviceId = currentReturnRental.deviceId;

        await deleteDoc(doc(window.db, 'rentals', deletedRentalId));

        // 로컬 상태 즉시 업데이트
        allRentals = allRentals.filter(r => r.id !== deletedRentalId);

        // 해당 단말 상태 업데이트
        const device = allDevices.find(d => d.id === deletedDeviceId);
        if (device) {
            device.status = device.note ? 'unavailable' : 'available';
            device.rentedBy = null;
            device.rentalType = null;
        }

        closeReturnModal();
        renderDevices();
        showToast('반납 처리가 완료되었습니다', 'success');

    } catch (error) {
        console.error('Return processing failed:', error);
        showToast('반납 처리 중 오류가 발생했습니다', 'error');
    } finally {
        submitBtn.classList.remove('loading');
        submitBtn.disabled = false;
    }
}

async function searchUserRentals() {
    const renterName = document.getElementById('extendRenterName').value.trim();

    if (renterName.length < 2) {
        showToast('대여자명을 2자 이상 입력하세요', 'warning');
        return;
    }

    const rentals = await getUserCurrentRentals(renterName);

    const rentalsContainer = document.getElementById('currentRentals');
    const noRentals = document.getElementById('noRentals');
    const extendForm = document.getElementById('extendForm');

    if (rentals.length === 0) {
        rentalsContainer.innerHTML = '';
        noRentals.style.display = 'block';
        extendForm.style.display = 'none';
        return;
    }

    noRentals.style.display = 'none';
    extendForm.style.display = 'block';

    // 대여 목록 렌더링
    rentalsContainer.innerHTML = rentals.map(rental => {
        const device = allDevices.find(d => d.id === rental.deviceId) || {};
        return `
            <div class="rental-item" data-rental-id="${rental.id}">
                <input type="checkbox" id="rental-${rental.id}">
                <div class="rental-item-info">
                    <div class="rental-item-model">${rental.deviceId} - ${rental.deviceName || device.model || '알 수 없음'}</div>
                    <div class="rental-item-detail">${device.os || ''} ${device.osVersion || ''}</div>
                </div>
                <span class="rental-item-status">${rental.status === 'approved' ? '대여중' : '신청중'}</span>
            </div>
        `;
    }).join('');

    // 체크박스 이벤트 바인딩
    rentalsContainer.querySelectorAll('.rental-item').forEach(item => {
        const checkbox = item.querySelector('input[type="checkbox"]');
        const rentalId = item.dataset.rentalId;

        item.addEventListener('click', (e) => {
            if (e.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
            }

            if (checkbox.checked) {
                item.classList.add('selected');
                if (!selectedExtendRentals.includes(rentalId)) {
                    selectedExtendRentals.push(rentalId);
                }
            } else {
                item.classList.remove('selected');
                selectedExtendRentals = selectedExtendRentals.filter(id => id !== rentalId);
            }

            updateExtendCount();
        });
    });

    updateExtendCount();
}

function updateExtendCount() {
    document.getElementById('extendDeviceCount').textContent = selectedExtendRentals.length;
}

async function handleExtendSubmit() {
    // 연속 클릭 방지
    if (isSubmitLocked('extend')) {
        console.log('Extend submit is locked - preventing duplicate submission');
        return;
    }

    if (selectedExtendRentals.length === 0) {
        showToast('연장할 단말을 선택해주세요', 'warning');
        return;
    }

    setSubmitLock('extend', 3000);  // 3초간 중복 제출 방지

    const submitBtn = document.getElementById('extendSubmitBtn');
    submitBtn.classList.add('loading');
    submitBtn.disabled = true;

    try {
        // 선택된 대여 건들의 반납일을 연장 (서버 시간 사용)
        const serverTime = getCurrentServerTime();
        const newEndDate = currentPeriod.rentalEnd;

        for (const rentalId of selectedExtendRentals) {
            const rentalRef = doc(db, 'rentals', rentalId);
            await updateDoc(rentalRef, {
                endDate: newEndDate,
                extendedAt: serverTime.toISOString(),
                updatedAt: serverTime.toISOString()
            });
        }

        showToast(`${selectedExtendRentals.length}개 단말의 대여가 연장되었습니다`, 'success');
        closeExtendModal();

    } catch (error) {
        console.error('연장 신청 오류:', error);
        showToast('연장 신청 중 오류가 발생했습니다', 'error');
    } finally {
        submitBtn.classList.remove('loading');
        submitBtn.disabled = false;
    }
}

// ============================================
// 이벤트 리스너
// ============================================
function setupEventListeners() {
    // 검색 필터 이벤트
    elements.searchInput.addEventListener('input', (e) => {
        currentFilters.search = e.target.value;
        renderDevices();
    });

    // OS 필터 태그 클릭 이벤트
    elements.osFilterTags.addEventListener('click', (e) => {
        const tag = e.target.closest('.os-tag');
        if (!tag) return;

        // 활성 상태 업데이트
        elements.osFilterTags.querySelectorAll('.os-tag').forEach(t => t.classList.remove('active'));
        tag.classList.add('active');

        currentFilters.os = tag.dataset.os;
        renderDevices();
    });

    // 상태 필터 태그 클릭 이벤트
    elements.statusFilterTags.addEventListener('click', (e) => {
        const tag = e.target.closest('.status-tag');
        if (!tag) return;

        // 활성 상태 업데이트
        elements.statusFilterTags.querySelectorAll('.status-tag').forEach(t => t.classList.remove('active'));
        tag.classList.add('active');

        currentFilters.status = tag.dataset.status;
        renderDevices();
    });

    elements.resetFiltersBtn.addEventListener('click', resetFilters);

    // 직접 입력 버튼
    document.getElementById('manualEntryBtn').addEventListener('click', openManualEntryModal);

    // 다운로드 버튼
    elements.downloadBtn.addEventListener('click', openDownloadModal);

    // 대여 신청 모달
    document.getElementById('modalClose').addEventListener('click', closeRentalModal);
    document.getElementById('cancelBtn').addEventListener('click', closeRentalModal);
    elements.rentalForm.addEventListener('submit', handleFormSubmit);

    elements.rentalModal.addEventListener('click', (e) => {
        if (e.target === elements.rentalModal) closeRentalModal();
    });

    // 다운로드 모달
    document.getElementById('downloadModalClose').addEventListener('click', closeDownloadModal);
    document.getElementById('downloadExcel').addEventListener('click', downloadAsExcel);
    document.getElementById('downloadConfluence').addEventListener('click', downloadAsConfluence);
    document.getElementById('downloadTemplate').addEventListener('click', downloadTemplate);

    elements.downloadModal.addEventListener('click', (e) => {
        if (e.target === elements.downloadModal) closeDownloadModal();
    });

    // 사유 글자수 카운트
    const reasonTextarea = document.getElementById('reason');
    reasonTextarea.addEventListener('input', (e) => {
        document.getElementById('reasonCount').textContent = e.target.value.length;
    });

    // 연장 신청 모달
    document.getElementById('extendModalClose').addEventListener('click', closeExtendModal);
    document.getElementById('extendCancelBtn').addEventListener('click', closeExtendModal);
    document.getElementById('extendSubmitBtn').addEventListener('click', handleExtendSubmit);
    document.getElementById('searchRentalsBtn').addEventListener('click', searchUserRentals);

    // 대여자명 입력 시 Enter로 검색
    document.getElementById('extendRenterName').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            searchUserRentals();
        }
    });

    elements.extendModal.addEventListener('click', (e) => {
        if (e.target === elements.extendModal) closeExtendModal();
    });

    // 반납/회수 모달
    document.getElementById('returnModalClose').addEventListener('click', closeReturnModal);
    document.getElementById('returnCancelBtn').addEventListener('click', closeReturnModal);
    elements.returnForm.addEventListener('submit', handleReturnSubmit);

    elements.returnModal.addEventListener('click', (e) => {
        if (e.target === elements.returnModal) closeReturnModal();
    });

    // ESC 키로 모달 닫기
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (elements.rentalModal.classList.contains('active')) {
                closeRentalModal();
            }
            if (elements.downloadModal.classList.contains('active')) {
                closeDownloadModal();
            }
            if (elements.extendModal.classList.contains('active')) {
                closeExtendModal();
            }
            if (elements.returnModal.classList.contains('active')) {
                closeReturnModal();
            }
        }
    });
}

// ============================================
// 유틸리티 함수
// ============================================

/**
 * 연속 클릭 방지를 위한 debounce 상태 관리
 */
const submitLocks = {
    rental: false,
    extend: false,
    return: false
};

/**
 * 버튼 잠금 설정 (지정된 시간 후 자동 해제)
 * @param {string} key - 잠금 키 (rental, extend, return)
 * @param {number} duration - 잠금 시간 (ms), 기본 2000ms
 */
function setSubmitLock(key, duration = 2000) {
    submitLocks[key] = true;
    setTimeout(() => {
        submitLocks[key] = false;
    }, duration);
}

/**
 * 버튼 잠금 상태 확인
 * @param {string} key - 잠금 키
 * @returns {boolean} 잠금 상태
 */
function isSubmitLocked(key) {
    return submitLocks[key] === true;
}

function getTypeIcon(type) {
    const icons = { phone: '📱', tablet: '📱', buds: '🎧' };
    return icons[type] || '📱';
}

function getTypeName(type) {
    const names = { phone: '폰', tablet: '태블릿', buds: '버즈' };
    return names[type] || '기타';
}

function getStatusInfo(device) {
    const statusMap = {
        available: { text: '대여 가능' },
        pending: { text: '신청 진행중' },
        rented: { text: '대여중' },
        overdue: { text: '회수 대상' },
        unavailable: { text: '사용 불가' }
    };
    return statusMap[device.status] || { text: '알 수 없음' };
}

function updateDeviceStats() {
    // 전체 단말 기준으로 통계 계산 (필터 적용 전)
    const total = allDevices.length;
    const available = allDevices.filter(d => d.status === 'available').length;
    const rented = allDevices.filter(d => d.status === 'rented' || d.status === 'pending').length;
    const overdue = allDevices.filter(d => d.status === 'overdue').length;
    const unavailable = allDevices.filter(d => d.status === 'unavailable').length;

    // 숫자 업데이트
    const statTotal = document.getElementById('statTotal');
    const statAvailable = document.getElementById('statAvailable');
    const statRented = document.getElementById('statRented');
    const statOverdue = document.getElementById('statOverdue');
    const statUnavailable = document.getElementById('statUnavailable');

    if (statTotal) statTotal.textContent = total;
    if (statAvailable) statAvailable.textContent = available;
    if (statRented) statRented.textContent = rented;
    if (statOverdue) statOverdue.textContent = overdue;
    if (statUnavailable) statUnavailable.textContent = unavailable;

    // 통계 바 업데이트
    if (total > 0) {
        const availablePercent = (available / total) * 100;
        const rentedPercent = (rented / total) * 100;
        const overduePercent = (overdue / total) * 100;
        const unavailablePercent = (unavailable / total) * 100;

        const barAvailable = document.getElementById('statsBarAvailable');
        const barRented = document.getElementById('statsBarRented');
        const barOverdue = document.getElementById('statsBarOverdue');
        const barUnavailable = document.getElementById('statsBarUnavailable');

        if (barAvailable) barAvailable.style.width = `${availablePercent}%`;
        if (barRented) barRented.style.width = `${rentedPercent}%`;
        if (barOverdue) barOverdue.style.width = `${overduePercent}%`;
        if (barUnavailable) barUnavailable.style.width = `${unavailablePercent}%`;
    }
}

function updateConnectionStatus(connected) {
    if (connected) {
        elements.statusDot.classList.add('connected');
        elements.statusDot.classList.remove('disconnected');
        elements.statusText.textContent = '실시간 연결됨';
    } else {
        elements.statusDot.classList.add('disconnected');
        elements.statusDot.classList.remove('connected');
        elements.statusText.textContent = '연결 끊김';
    }
}

function showLoading() {
    elements.loadingSpinner.classList.remove('hidden');
    elements.deviceGrid.classList.add('hidden');
}

function hideLoading() {
    elements.loadingSpinner.classList.add('hidden');
}

function showToast(message, type = 'info') {
    elements.toast.textContent = message;
    elements.toast.className = 'toast';
    if (type) elements.toast.classList.add(type);
    elements.toast.classList.add('show');

    setTimeout(() => {
        elements.toast.classList.remove('show');
    }, 3000);
}

// ============================================
// 디버그 기능 (개발용)
// ============================================
function setupDebugMode() {
    // 개발 환경에서만 디버그 패널 활성화
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        // Ctrl+Shift+D로 디버그 패널 토글
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && e.key === 'D') {
                e.preventDefault();
                showDebugInfo();
            }
        });
        console.log('디버그 모드 활성화: Ctrl+Shift+D로 디버그 패널 표시');
    }
}

function showDebugInfo() {
    const debugPanel = document.getElementById('debugPanel');
    const debugInfo = document.getElementById('debugInfo');

    if (!debugPanel || !debugInfo) {
        console.log('디버그 패널이 없습니다. index.html에 추가해주세요.');
        // 콘솔에 디버그 정보 출력
        logDebugInfo();
        return;
    }

    const serverTime = getCurrentServerTime();
    const clientTime = new Date();
    const offset = getServerTimeOffset();

    debugInfo.innerHTML = `
        <p><strong>서버 시간:</strong> ${serverTime.toLocaleString('ko-KR')}</p>
        <p><strong>클라이언트 시간:</strong> ${clientTime.toLocaleString('ko-KR')}</p>
        <p><strong>시간 차이:</strong> ${Math.round(offset / 1000)}초</p>
        <p><strong>동기화 상태:</strong> ${isTimeSynced() ? '완료' : '미완료'}</p>
        <p><strong>신청 기간 상태:</strong> ${periodStatus}</p>
        <p><strong>현재 분기:</strong> ${currentPeriod?.quarter || '없음'}</p>
    `;

    debugPanel.style.display = debugPanel.style.display === 'none' ? 'block' : 'none';
}

function logDebugInfo() {
    const serverTime = getCurrentServerTime();
    const clientTime = new Date();
    const offset = getServerTimeOffset();

    console.group('디버그 정보');
    console.log('서버 시간:', serverTime.toLocaleString('ko-KR'));
    console.log('클라이언트 시간:', clientTime.toLocaleString('ko-KR'));
    console.log('시간 차이:', Math.round(offset / 1000), '초');
    console.log('동기화 상태:', isTimeSynced() ? '완료' : '미완료');
    console.log('신청 기간 상태:', periodStatus);
    console.log('현재 분기:', currentPeriod?.quarter || '없음');
    console.groupEnd();
}

// ============================================
// 앱 시작
// ============================================
document.addEventListener('DOMContentLoaded', init);
