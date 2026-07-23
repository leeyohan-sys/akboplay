import { Alert, Platform } from 'react-native';

/**
 * 웹에서는 Alert.alert 버튼이 안 보이거나 동작하지 않는 경우가 많아
 * window.confirm / alert 로 대체합니다.
 */
export function showAlert(title: string, message?: string) {
  const text = message ? `${title}\n\n${message}` : title;
  if (Platform.OS === 'web') {
    window.alert(text);
    return;
  }
  Alert.alert(title, message);
}

export function confirmDialog(
  title: string,
  message: string,
  onConfirm: () => void,
  confirmLabel = '확인',
): void {
  if (Platform.OS === 'web') {
    const ok = window.confirm(`${title}\n\n${message}\n\n[${confirmLabel}]`);
    if (ok) onConfirm();
    return;
  }

  Alert.alert(title, message, [
    { text: '취소', style: 'cancel' },
    { text: confirmLabel, onPress: onConfirm },
  ]);
}

export function choiceDialog(
  title: string,
  message: string,
  actions: { text: string; onPress?: () => void; style?: 'cancel' | 'default' }[],
): void {
  if (Platform.OS === 'web') {
    const labels = actions.map((a, i) => `${i + 1}. ${a.text}`).join('\n');
    const raw = window.prompt(`${title}\n\n${message}\n\n${labels}\n\n번호를 입력하세요`);
    const idx = Number(raw) - 1;
    if (idx >= 0 && idx < actions.length) {
      actions[idx].onPress?.();
    }
    return;
  }

  Alert.alert(title, message, actions);
}
