import { locations } from '@contentful/app-sdk';
import { useSDK } from '@contentful/react-apps-toolkit';
import Page from './locations/Page';

export default function App() {
  const sdk = useSDK();
  if (sdk.location.is(locations.LOCATION_PAGE)) {
    return <Page />;
  }
  return null;
}
