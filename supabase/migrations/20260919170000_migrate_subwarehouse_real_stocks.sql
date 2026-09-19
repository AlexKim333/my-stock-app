-- ==============================================================================
-- 2026-09-19 외부(서브)창고 실사 데이터 정규 마이그레이션 (Direct UUID + Master Creation)
-- ==============================================================================

DO $$
DECLARE
  v_p_count INT;
  v_i_count INT;
  v_l_count INT;
  v_pino_count INT;
  v_t_count INT;
  v_grand_total INT;
BEGIN
  -- 1. 미등록 실사 품목 마스터 15건 사전 등록
  INSERT INTO public.items (item_name, color, box_packaging_qty, is_active) VALUES
    ('BL-50', 'BLANCO', 500, TRUE),
    ('BL-50', 'PALOROSA', 500, TRUE),
    ('BL-50', 'ROJO', 500, TRUE),
    ('BL-60', 'BLANCO', 500, TRUE),
    ('BL-60', 'PALOROSA', 500, TRUE),
    ('BL-60', 'ROJO', 500, TRUE),
    ('BL-70', 'BLANCO', 500, TRUE),
    ('BL-70', 'PALOROSA', 500, TRUE),
    ('BL-70', 'ROJO', 500, TRUE),
    ('BL-80', 'BLANCO', 500, TRUE),
    ('BL-80', 'PALOROSA', 500, TRUE),
    ('BL-80', 'ROJO', 500, TRUE),
    ('SYA6', 'SURTIDO', 1, TRUE),
    ('SXY-2320', 'NEGRO', 1, TRUE),
    ('SXY-2320', 'PALOROSA', 1, TRUE)
  ON CONFLICT (item_name, color, box_packaging_qty) DO NOTHING;

  -- 2. 기존 외부창고(non-MAIN) 재고 완전 0으로 초기화
  UPDATE public.inventory_stocks
  SET box_qty = 0,
      unit_qty = 0,
      updated_at = NOW()
  WHERE warehouse_code <> 'MAIN';

  -- 3. 실사 재고 적재용 임시 테이블
  CREATE TEMP TABLE _stage_direct_stock (
    item_id UUID,
    pantaco INT,
    ikea INT,
    lerma INT,
    pino INT,
    tlane INT
  ) ON COMMIT DROP;

  -- 3-1. DB 기존 품목 (UUID 직접 바인딩 224건)
  INSERT INTO _stage_direct_stock (item_id, pantaco, ikea, lerma, pino, tlane) VALUES
    ('4fa8fea6-10cb-4cb7-be19-e34d7fb00df0', 7, 0, 10, 0, 24),
    ('09c26315-3f0a-4e4c-b010-dfe974578509', 5, 66, 0, 0, 0),
    ('039bc208-2eb4-4698-b008-d81bc2a427f7', 0, 23, 0, 0, 0),
    ('c93a2547-4740-4e52-a1c0-b4f386c3e6a0', 0, 6, 0, 0, 0),
    ('8c3503c0-42db-43f8-8d07-5d48835a1be8', 0, 29, 0, 0, 0),
    ('bcf57f02-c157-4b42-8e5c-0b559e855669', 0, 42, 0, 0, 0),
    ('4db217d4-3d97-41eb-8462-3db09bf6c8e3', 0, 39, 0, 0, 0),
    ('abb4cc7d-3bc3-43a5-ae63-4d5a4e5b0280', 0, 21, 0, 0, 0),
    ('fdc9cf00-b567-4fbb-ba0b-778c4d604f57', 18, 17, 0, 0, 0),
    ('ca1944dc-820f-417d-9584-2f6ceba5d913', 0, 11, 0, 0, 11),
    ('7d8cc7e1-673e-4f09-a557-ae5a29ca575f', 0, 28, 0, 0, 0),
    ('ab94da93-4340-415a-b1f2-aedf63bded9a', 0, 742, 0, 0, 0),
    ('e7251d5d-9063-4e20-9b82-5b8d944911ae', 23, 42, 0, 0, 0),
    ('3bf7b604-1659-4203-9a90-dbe3c5c38719', 16, 17, 0, 0, 0),
    ('f9d1e29e-efc6-4ef3-84c6-6ea38c7fbf54', 12, 12, 0, 0, 0),
    ('cc88a882-3324-40e5-b2b0-cb87a51c351e', 0, 21, 0, 0, 0),
    ('1158a946-d7be-4123-a099-effeea3f2652', 2, 34, 0, 0, 0),
    ('98e8067d-e2ba-4986-8c32-4eeab3c22073', 0, 10, 0, 0, 0),
    ('2f855d90-8836-4cfd-b912-8615afd32fab', 11, 14, 0, 0, 0),
    ('cb854c06-7eb8-44f6-aac4-396f82c1f12c', 0, 38, 0, 0, 0),
    ('727406d0-1964-44ae-9a01-e412a730eaff', 6, 4, 0, 0, 0),
    ('97aa6424-f40c-4e37-a9c9-453f86728182', 27, 0, 0, 0, 0),
    ('43ae9818-a9d4-4721-bce0-763a071da42d', 0, 23, 0, 0, 0),
    ('a44ade2c-ee1c-45fd-a46e-36587587bbe3', 0, 7, 0, 0, 0),
    ('9eceb681-92c2-4237-a43a-3e7f423a6e61', 13, 31, 0, 0, 0),
    ('5c6f1728-5e73-46a6-bf6f-874b33e18348', 2, 30, 0, 0, 0),
    ('c32994ab-02da-4730-b5cf-03926910bdc0', 41, 0, 0, 0, 0),
    ('331d6e72-744d-4f3f-8c39-53563fd1b0c9', 17, 23, 0, 0, 0),
    ('8c54aca8-469a-404a-b9fe-a3c7ba02b8a9', 0, 40, 0, 0, 0),
    ('c30178d1-87f5-4201-954c-6d98da1266e3', 0, 208, 0, 0, 0),
    ('b92e457e-1e6f-488a-942e-36d831dda542', 0, 41, 0, 0, 0),
    ('de610a9e-332c-42a7-8754-06f4b89959e1', 5, 11, 0, 0, 0),
    ('7b05ffa5-df27-45a5-b8f7-154d99c8aa6a', 0, 0, 0, 0, 3),
    ('a8f4d81a-6f8f-447f-8543-5ca604cd36bd', 4, 25, 0, 0, 0),
    ('62ab70f0-9f01-4302-b210-bbc4e5698bfc', 2, 29, 0, 0, 0),
    ('828f4911-fcb8-443d-9b65-57580ca02e22', 2, 31, 0, 0, 0),
    ('65e93b0a-2ca0-4474-9221-3654d72e9fb0', 0, 0, 0, 0, 1),
    ('6d0c7a16-e6c5-4a86-bca4-be863ed8b3dd', 6, 20, 0, 0, 11),
    ('038a0c6c-b076-47df-802b-36644fd9b192', 0, 2, 0, 0, 1),
    ('072568cf-2cde-4cdc-8fa2-f7085324243e', 39, 20, 0, 0, 0),
    ('b862272a-93e2-4246-af92-fa56fd85913b', 5, 0, 0, 0, 0),
    ('893ce21c-c099-4ebe-863c-1c41b5bdb712', 0, 40, 0, 0, 0),
    ('ff159776-08ef-479f-ace5-7fca4c74ec88', 0, 44, 0, 0, 0),
    ('7716fe01-a847-4299-8d16-a69aa8dcede2', 3, 0, 0, 0, 0),
    ('ab42991d-689b-4d3a-8ae8-86abc95885e5', 9, 0, 0, 0, 0),
    ('f337e719-c24f-4c7f-9e91-539761b6a753', 1, 0, 0, 0, 0),
    ('dd730cdd-6160-4f6f-839b-60201d9612cf', 1, 0, 0, 0, 0),
    ('c0fb5461-59c0-4d1d-8bfc-d445cfedcbb6', 5, 0, 0, 0, 0),
    ('4faff5a9-868d-4c9f-bdc0-8de45fae5924', 2, 0, 0, 0, 0),
    ('48bbfe1b-9250-4e9b-914c-234d5b2dec11', 1, 0, 0, 0, 0),
    ('18a3514b-3a91-43e4-9bc9-e9fca073a0a9', 3, 0, 0, 0, 0),
    ('5d415fbf-d8cd-4d1a-a8fa-1428abbffa7d', 70, 0, 0, 0, 0),
    ('cb47e1ca-0b5e-4cae-96be-bec3a7865f22', 10, 0, 0, 0, 0),
    ('7a0fd971-c891-4289-8f93-94b2a5d0a151', 1, 0, 0, 0, 0),
    ('7aedc762-9c62-49ce-81e8-6ea84b7fa93a', 2, 0, 0, 0, 0),
    ('2ab11275-edaa-472b-99c1-4ebda8d4af77', 2, 0, 0, 0, 0),
    ('9aee63b6-5e8a-4fd6-bebd-3839dfe17b53', 6, 0, 0, 0, 0),
    ('640776b4-4e86-4aba-b83c-52075d647eb0', 2, 0, 0, 0, 0),
    ('1111b21b-d59c-4570-9845-ad88395ed940', 0, 0, 0, 0, 52),
    ('927337f8-491e-4bea-8109-83369ab54582', 11, 0, 0, 0, 0),
    ('aefa4d13-7d32-40fe-8fb1-23feb62b004a', 10, 0, 0, 0, 0),
    ('30155412-27a2-4963-93fa-25dc922373e6', 75, 32, 0, 0, 0),
    ('7b86c0e9-49fc-483f-9406-ebfa3050ea43', 0, 0, 0, 0, 10),
    ('615e5622-624c-437c-9d5d-a1ae184cb3ad', 47, 28, 0, 0, 0),
    ('403a5d16-a7ee-43e7-b956-b08b50e1c6f1', 1, 0, 0, 0, 0),
    ('03d1c3f1-d647-4297-abe2-589c7fae0435', 51, 87, 0, 0, 0),
    ('ed38c4af-5eee-495f-a603-dd9d011a7e26', 110, 0, 0, 0, 0),
    ('3c5f8345-fdae-480c-b6d2-a72e1c198879', 5, 0, 0, 0, 0),
    ('6c6a2ace-bd11-45a2-82b6-cd48d479481e', 27, 0, 0, 0, 0),
    ('ae6d00a1-04ce-4d0b-b277-51871c84a63e', 4, 0, 0, 0, 0),
    ('96339558-d86a-46f0-ad30-ab230074670f', 6, 0, 0, 0, 0),
    ('19f3c0c7-37b5-4e3c-a559-67cc8f6d6c3f', 0, 30, 0, 0, 0),
    ('42d0c764-7d7f-4075-87c3-c87132363051', 0, 31, 0, 0, 0),
    ('b452ce54-c033-4058-baa1-ee2539e36d9e', 91, 155, 0, 0, 0),
    ('677fce2f-ff59-4152-bbd5-76cc4345d686', 30, 41, 0, 0, 0),
    ('b521db04-9973-494c-a765-51f0e287f64f', 1, 16, 0, 0, 0),
    ('050ccf83-ee90-4b9f-95cf-86816d50d6fd', 54, 96, 0, 0, 0),
    ('c4d1f943-3e1b-441d-ba62-d60aed915fb2', 0, 25, 0, 0, 15),
    ('43e04c60-a374-490b-9ff8-154b9e700de6', 0, 45, 0, 0, 1),
    ('c235e4b4-01b6-4d50-b5f0-554fc347f20c', 0, 15, 0, 0, 0),
    ('de420351-8ae5-4b57-b385-9ae3f7f28975', 5, 0, 0, 0, 0),
    ('e7e4fa25-a679-473e-8329-429492788f2e', 0, 12, 0, 0, 0),
    ('83851e90-3cb6-49ed-93a4-63f52380bd2f', 0, 0, 0, 0, 0),
    ('b21241bd-0b29-4825-b76d-a894829869e5', 8, 0, 0, 0, 0),
    ('3672efe2-8277-45bb-a6c5-baac0e38759c', 0, 4, 0, 0, 8),
    ('78042d8c-a2ba-4528-8656-6522f2645181', 3, 18, 0, 0, 5),
    ('f158be70-2b58-43ae-a14f-ed1863454bf5', 0, 3, 11, 0, 0),
    ('e51d21a3-4f76-4154-abbf-20bf8da312af', 0, 1, 0, 0, 0),
    ('1e70baf2-cbda-4d7c-83be-4272df307163', 0, 0, 0, 0, 15),
    ('41a01a88-367e-4fab-8bb6-cc561d73e194', 0, 17, 0, 0, 5),
    ('84fcc8ec-dd6a-4932-95a0-6b213f6dad7f', 3, 0, 0, 0, 0),
    ('586ece73-fa4b-44cc-9b2e-7cfcf60100d6', 7, 0, 0, 0, 0),
    ('637e7a2b-079b-41c4-bef5-b7c4e13ec4a8', 14, 0, 0, 0, 7),
    ('57686b95-6619-4ed4-a90e-92a37109ea3a', 1, 18, 0, 0, 13),
    ('4d9209bc-437a-454e-a925-456d0c2c25ea', 11, 13, 0, 0, 0),
    ('bb3a11e9-2257-44c8-a3b2-947fa08699ed', 0, 0, 0, 0, 10),
    ('7f7c8f6f-2c48-4ad2-a8ef-5c449212ce47', 0, 0, 0, 0, 10),
    ('b8f4c0a2-b219-48ce-8e01-f9db539581b9', 0, 0, 0, 0, 79),
    ('6f51c3a8-15eb-481c-a7f5-57394224c5dd', 0, 0, 5, 0, 0),
    ('53a0ddfd-4ad9-429c-9218-6ef6440e4e38', 0, 1, 0, 1, 0),
    ('3e3deccf-8938-4cb7-94aa-926236f6f151', 0, 31, 118, 0, 0),
    ('84b3b4f7-e04e-4a15-8641-f72f47f01670', 0, 167, 0, 234, 100),
    ('e3d72980-4b3c-493c-a20b-8b87a79df8f4', 0, 0, 10, 0, 1),
    ('7edf1d92-3f6e-4c32-bb6f-11fac83599d8', 0, 0, 1, 0, 0),
    ('aa53525a-4eaf-4599-9e7a-89b5fa79b794', 0, 1, 0, 0, 0),
    ('3f177752-86cb-4f8b-92fd-514ceea0141a', 0, 0, 0, 1, 0),
    ('f7474877-11e5-4969-a61c-ed6f11a14b80', 0, 0, 0, 0, 0),
    ('d2a3df63-ba35-49c8-a71f-f16d9623e3a4', 0, 0, 5, 0, 0),
    ('9cbc797b-356e-4a36-a4ce-68c50803517b', 0, 0, 17, 1, 0),
    ('d7e5e96f-c629-41d5-9263-3e4ac5b0a03b', 0, 525, 7, 570, 0),
    ('e7bb3a76-1ffc-44e5-8f85-4bd46e7d116e', 0, 171, 0, 0, 0),
    ('d83aff1b-80cc-4c02-9049-b0accd06fc30', 0, 135, 0, 0, 0),
    ('aa38c87b-ff2f-4a4f-bea7-907a967e55c1', 0, 1, 0, 0, 0),
    ('03a70748-2d54-4ee6-914e-3f3a7707de80', 0, 0, 7, 0, 0),
    ('f212308e-0408-46a9-a29a-1f4ebc939c4f', 0, 107, 0, 0, 0),
    ('036183ab-ca72-4882-957e-63ea8070ce33', 0, 165, 0, 0, 0),
    ('2d044c84-01e0-45c1-9c3e-d138fb525b94', 0, 0, 6, 0, 0),
    ('ed2ac11f-36de-43e8-9a41-22a85ebfe657', 0, 192, 7, 0, 0),
    ('298a97e8-c457-4fce-907d-5d22b0c241ab', 0, 93, 0, 0, 0),
    ('2fcd02e2-b936-4ca0-8ac1-7b35441487a3', 0, 6, 0, 0, 0),
    ('2c9eced5-18eb-42e3-89a3-18b3482edad8', 0, 384, 0, 0, 0),
    ('46b4bc30-44c7-4fd9-9d5c-1fc0e7f8b9a6', 0, 10, 2, 3, 0),
    ('1d286d7e-5dd5-4cde-907a-af1c54b9d415', 0, 5, 0, 0, 0),
    ('7bc68ad7-6fb8-4fe8-9469-b97c1bb89a6a', 84, 16, 0, 0, 0),
    ('f77691b4-687d-474a-a753-06acac97ee2c', 106, 5, 0, 0, 0),
    ('32928249-7466-435e-85ac-51868ba93ff9', 154, 0, 0, 0, 0),
    ('8775b192-2468-45fc-a548-4d453b3a58f9', 11, 0, 0, 0, 0),
    ('6b20a67c-d01b-4ccc-adb7-a4d9420ace20', 116, 0, 0, 0, 0),
    ('ccf56235-d87a-47fa-ad66-4b81ac3fb601', 266, 1, 0, 0, 0),
    ('0e3472ea-c5c1-4405-b54a-f14fa1b3397d', 341, 1, 0, 0, 0),
    ('8f8c7bec-6f2a-43c9-955c-6e153e693cc3', 220, 45, 0, 0, 0),
    ('74aedf95-121d-40aa-972b-be3702d65bfa', 259, 412, 0, 0, 0),
    ('df228778-578f-4ec4-9551-b588f2aa4086', 208, 39, 0, 0, 0),
    ('0d55b085-8690-4122-8f77-e286f05cf25f', 0, 314, 0, 0, 0),
    ('f5136b5c-dd74-42c9-ab39-f4e27dda5301', 57, 37, 0, 0, 0),
    ('dd95d82f-d46b-4708-9cd3-1af32ec037f8', 0, 0, 1, 0, 0),
    ('bb4aa551-2542-4158-be20-49784d59c2c4', 0, 1, 0, 0, 0),
    ('532c6f37-e2fd-434e-b242-ab3094d1dfaa', 0, 213, 6, 0, 0),
    ('737e8878-32bd-4757-b8cf-7414761eb74e', 0, 0, 0, 0, 0),
    ('4c4e76c0-3fae-4ffd-9b83-6b674d71b80e', 0, 24, 0, 0, 0),
    ('31a6b8e9-9790-4b91-9a91-af9daf8a5034', 0, 4, 0, 0, 0),
    ('5e2b360c-077f-4a05-95cc-62a8729e1c9c', 0, 133, 0, 0, 0),
    ('8b92222b-0515-4540-a8de-5fd7a31151e5', 0, 0, 0, 0, 22),
    ('77f9d6b4-f3a5-49f8-8026-d7840846b1a8', 0, 0, 0, 0, 23),
    ('a2b18cee-d599-43b7-bbfc-d9658ad4cf58', 0, 0, 0, 0, 36),
    ('926fe71c-9223-4bab-95d7-a0da42da9743', 0, 0, 0, 0, 14),
    ('6bae494b-071b-462a-892f-52af5854bfc9', 0, 0, 0, 0, 43),
    ('dfc0371b-7dce-4c6a-8001-87d88de6052c', 0, 0, 0, 0, 41),
    ('9f5909d8-029f-4262-8db1-8047dec3a1bf', 0, 0, 0, 0, 5),
    ('12ce1f7a-39ed-452c-aa3a-15254fc65d59', 0, 0, 0, 0, 23),
    ('a691f7b9-2634-4706-9115-b1e3dacf27f1', 0, 0, 0, 0, 4),
    ('aab8c418-a97c-40f0-9f2b-fbaf11604c5c', 0, 0, 0, 0, 1),
    ('2bdd68c9-39ec-4ac8-82e4-96505dd46e28', 0, 0, 0, 0, 1),
    ('2d130fd3-ef10-470a-aa9d-a94b25075629', 49, 0, 0, 0, 0),
    ('c44bc1a0-9aa8-4952-80ad-34808c466fb1', 7, 0, 0, 0, 0),
    ('27f458a9-d54e-4591-84ad-81032b19bfad', 0, 0, 0, 0, 52),
    ('e3d21dbe-4e80-4430-a6e3-90941defe63b', 0, 0, 0, 0, 19),
    ('c8b8966b-0667-467d-872f-ab10854dd25c', 0, 0, 0, 0, 52),
    ('c5ad9a08-c407-44ba-bcbd-6c54f0792bb6', 0, 0, 0, 0, 1),
    ('bbaddb0d-04d5-4db3-946a-4972fc3bf70a', 0, 0, 0, 0, 9),
    ('690b5988-d158-454f-9698-ea4ca4b480bb', 0, 0, 0, 0, 14),
    ('60fa767d-c99a-462c-b74d-c7a2c96cf878', 0, 0, 0, 0, 9),
    ('c5ddccc2-4cb6-4a55-b639-3b9ea9afdef9', 0, 0, 0, 0, 13),
    ('a937a75e-29e8-4a16-aa67-65140b1be8b0', 0, 0, 0, 0, 12),
    ('a934006a-9cc9-4b5f-bc1d-d38040adfb61', 0, 0, 0, 0, 16),
    ('3c3cd5df-00c6-4a0a-ad18-1fabdee83564', 0, 0, 0, 0, 5),
    ('638a3c22-d5dd-4e00-bc7d-fee3d392024a', 0, 0, 0, 0, 2),
    ('637f4c39-2549-4276-a1fa-7e163e5864ca', 0, 0, 0, 0, 2),
    ('77f9033e-63ec-4c5a-b5db-07168ebbdb00', 0, 0, 0, 0, 6),
    ('6d0dcdfd-bcf4-4e1c-bbac-8dc2edc24b3c', 0, 0, 0, 0, 5),
    ('710b66f2-39b2-454c-9c1b-6e7a613bceb7', 0, 0, 0, 0, 5),
    ('ccc8f12f-6c9a-4e6e-9250-0c29f7b8acc3', 0, 0, 0, 0, 2),
    ('ae52b70f-b5bb-4299-a357-e5279973347a', 0, 0, 0, 0, 43),
    ('6dd583c5-64a7-4734-9f9a-2ab4115a4fdc', 0, 0, 0, 0, 9),
    ('46e0aec2-1f51-4dd7-8898-28512c0ef0ea', 0, 0, 0, 0, 6),
    ('566d355e-1b85-4c67-b766-7490fc7b790d', 0, 0, 0, 0, 44),
    ('9b544c73-4380-407f-859c-58b52a79fa57', 0, 0, 0, 0, 1),
    ('0bdc5a58-26e4-435c-a9eb-382f6d3df7e2', 61, 0, 0, 0, 0),
    ('5cd06ba9-8838-4ae7-96c6-d6b3f018eec9', 13, 0, 0, 0, 0),
    ('b1e5951c-080a-40dc-a351-cd3bf2092b63', 16, 0, 0, 0, 0),
    ('9eda1460-6017-49a6-80fa-248778a50e06', 0, 0, 201, 0, 0),
    ('4708fdf5-8594-4ecb-8f63-2a6a98d54c7c', 145, 0, 0, 0, 0),
    ('e3af0c9c-e1d5-44b2-b440-feab0e8b5db6', 0, 0, 0, 275, 0),
    ('9c779c71-9251-40a6-ad55-0cebfd1d5d8e', 133, 0, 0, 0, 0),
    ('f857c04b-4a0a-4be9-ae5b-198760079f36', 29, 0, 0, 0, 0),
    ('5a34e296-8ebb-44fb-80f7-19e161bb430f', 395, 0, 0, 0, 0),
    ('addeb694-2feb-42cf-b84b-9de4213235dd', 136, 0, 0, 0, 86),
    ('e966d7d5-9ff3-4264-b6a8-b0767bb626ce', 153, 19, 0, 30, 0),
    ('02fe3b37-3945-48fd-acb9-294f153a7a2c', 115, 0, 0, 0, 285),
    ('054b2ebe-672d-488b-b8e6-3e7abb7f60c6', 223, 0, 0, 0, 0),
    ('1114dd9e-160e-4a28-b85e-9c55122c5878', 0, 0, 0, 885, 0),
    ('a9b74a87-bd08-4740-9613-88e84611ccae', 198, 0, 0, 4, 0),
    ('cacf38ec-6e30-4256-8e45-0dc72210f5ef', 0, 136, 0, 89, 0),
    ('1d17dfc2-9ea1-4d8f-9034-33338ec2f8a3', 0, 0, 0, 2, 0),
    ('a2a1c6f5-1c16-403e-bdaa-4f1c7e15d875', 0, 0, 0, 0, 55),
    ('ef51032e-c838-40e3-a20f-7def9485b5ba', 0, 0, 0, 0, 5),
    ('783d72e0-0631-49b3-8c82-e4af0973a6f6', 13, 0, 0, 0, 0),
    ('264b1cd1-1362-491d-8648-03cccda371c5', 23, 0, 0, 0, 0),
    ('e6c9dce5-dbe2-476f-85c9-2c96cf28c2cb', 1, 0, 0, 0, 0),
    ('09b206c8-4306-41f5-8585-4bec3cb14df6', 8, 0, 0, 0, 0),
    ('254a8404-3628-4780-b75a-08f0d87a9faf', 28, 0, 0, 0, 0),
    ('4ee2e45d-b3e0-4cb0-a422-48a2982d1265', 28, 0, 0, 0, 0),
    ('1f005be7-76fa-42bf-baa9-07346aeabcb5', 0, 0, 0, 0, 2),
    ('723f4220-ad00-4c28-9f96-287c95f54996', 0, 0, 0, 0, 15),
    ('56ac5116-006c-4360-8dbf-9ff726f00942', 0, 0, 0, 0, 3),
    ('c5a2f0d8-7c9c-48e2-a415-befafd67baf1', 0, 0, 0, 0, 3),
    ('437fc04a-16f8-4cf2-be3c-c2a2ff82c6c0', 0, 0, 0, 0, 27),
    ('92dae67c-ee7e-4910-827f-e06f5514a16f', 0, 0, 0, 0, 52),
    ('4ec077a6-84ac-4c73-8014-429465152b8d', 0, 0, 0, 0, 5),
    ('9c36544d-76ee-4d76-a418-629acc0c076e', 0, 0, 0, 0, 10),
    ('365d5325-8e3a-456a-ac9d-119e3db742f5', 0, 0, 0, 0, 20),
    ('58bf1bd5-c99f-42d1-ace4-fb24393252c1', 0, 0, 0, 0, 1),
    ('92d688f2-b2b8-4f74-8c8f-13ef82b612a1', 0, 0, 0, 0, 1),
    ('6704f381-094d-4d42-872e-97a8d0419b37', 0, 0, 0, 0, 15),
    ('6d3ce897-8175-47d4-8d7d-4c03145a2182', 0, 0, 0, 0, 25),
    ('493fc7fa-8b26-4de2-a23b-bd063797d98a', 19, 0, 0, 0, 16),
    ('f0946e7e-da53-4bde-b396-0eed69a66ac8', 0, 0, 0, 0, 33),
    ('d98f85b2-883e-48a2-a92c-30c02ea97a86', 0, 0, 0, 0, 110),
    ('1a7c050f-bf59-4b0d-aab3-cc914b64727d', 0, 0, 0, 0, 72),
    ('c84a40ed-ab42-412d-b96b-ed432d5f8daf', 0, 0, 0, 0, 110),
    ('28f5d7e4-872e-451e-ae28-66b91c20e5ef', 0, 0, 0, 0, 78),
    ('7b1a7a4d-9911-4d3d-8de5-897a58d88504', 0, 0, 0, 0, 224),
    ('154e51ae-587a-4d99-ba7f-26152db51577', 0, 0, 0, 0, 10),
    ('787b0fde-af2b-46a3-9a0d-1ac672bb394f', 0, 0, 0, 0, 10);

  -- 3-2. 새로 등록된 품목 (15건 조인 적재)
  INSERT INTO _stage_direct_stock (item_id, pantaco, ikea, lerma, pino, tlane)
  SELECT i.id, s.pantaco, s.ikea, s.lerma, s.pino, s.tlane
  FROM (VALUES
    ('BL-50', 'BLANCO', 1, 0, 0, 0, 9),
    ('BL-50', 'PALOROSA', 3, 0, 0, 0, 0),
    ('BL-50', 'ROJO', 1, 0, 0, 0, 4),
    ('BL-60', 'BLANCO', 0, 0, 0, 0, 8),
    ('BL-60', 'PALOROSA', 4, 0, 0, 0, 0),
    ('BL-60', 'ROJO', 0, 0, 0, 0, 3),
    ('BL-70', 'BLANCO', 0, 1, 0, 0, 14),
    ('BL-70', 'PALOROSA', 8, 0, 0, 0, 0),
    ('BL-70', 'ROJO', 0, 0, 0, 0, 10),
    ('BL-80', 'BLANCO', 0, 2, 0, 0, 8),
    ('BL-80', 'PALOROSA', 11, 0, 0, 0, 0),
    ('BL-80', 'ROJO', 0, 0, 0, 0, 8),
    ('SYA6', 'SURTIDO', 0, 0, 0, 0, 3),
    ('SXY-2320', 'NEGRO', 0, 0, 0, 0, 10),
    ('SXY-2320', 'PALOROSA', 0, 0, 0, 0, 3)
  ) AS s(code, color, pantaco, ikea, lerma, pino, tlane)
  JOIN public.items i ON i.item_name = s.code AND i.color = s.color;

  -- 4. 창고별 Upsert 실행
  -- 4-1. PANTACO
  INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty, updated_at)
  SELECT item_id, 'PANTACO', pantaco, 0, NOW()
  FROM _stage_direct_stock
  WHERE pantaco > 0
  ON CONFLICT (item_id, warehouse_code) DO UPDATE
  SET box_qty = EXCLUDED.box_qty, unit_qty = 0, updated_at = NOW();

  -- 4-2. IKEA
  INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty, updated_at)
  SELECT item_id, 'IKEA', ikea, 0, NOW()
  FROM _stage_direct_stock
  WHERE ikea > 0
  ON CONFLICT (item_id, warehouse_code) DO UPDATE
  SET box_qty = EXCLUDED.box_qty, unit_qty = 0, updated_at = NOW();

  -- 4-3. LERMA
  INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty, updated_at)
  SELECT item_id, 'LERMA', lerma, 0, NOW()
  FROM _stage_direct_stock
  WHERE lerma > 0
  ON CONFLICT (item_id, warehouse_code) DO UPDATE
  SET box_qty = EXCLUDED.box_qty, unit_qty = 0, updated_at = NOW();

  -- 4-4. PINO
  INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty, updated_at)
  SELECT item_id, 'PINO', pino, 0, NOW()
  FROM _stage_direct_stock
  WHERE pino > 0
  ON CONFLICT (item_id, warehouse_code) DO UPDATE
  SET box_qty = EXCLUDED.box_qty, unit_qty = 0, updated_at = NOW();

  -- 4-5. TLANE
  INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty, updated_at)
  SELECT item_id, 'TLANE', tlane, 0, NOW()
  FROM _stage_direct_stock
  WHERE tlane > 0
  ON CONFLICT (item_id, warehouse_code) DO UPDATE
  SET box_qty = EXCLUDED.box_qty, unit_qty = 0, updated_at = NOW();

  -- 5. 감사 전표(stock_transactions) 기록 생성
  INSERT INTO public.stock_transactions (
    transaction_type, item_id, warehouse_code, box_qty, unit_qty, handler_name, invoice_no, memo
  )
  SELECT 'ADJUST', item_id, 'PANTACO', pantaco, 0, 'MIGRATION', 'ADJUST-20260919-MIG-PANTACO', '[실사마이그레이션] 실사 재고 정규 주입'
  FROM _stage_direct_stock WHERE pantaco > 0;

  INSERT INTO public.stock_transactions (
    transaction_type, item_id, warehouse_code, box_qty, unit_qty, handler_name, invoice_no, memo
  )
  SELECT 'ADJUST', item_id, 'IKEA', ikea, 0, 'MIGRATION', 'ADJUST-20260919-MIG-IKEA', '[실사마이그레이션] 실사 재고 정규 주입'
  FROM _stage_direct_stock WHERE ikea > 0;

  INSERT INTO public.stock_transactions (
    transaction_type, item_id, warehouse_code, box_qty, unit_qty, handler_name, invoice_no, memo
  )
  SELECT 'ADJUST', item_id, 'LERMA', lerma, 0, 'MIGRATION', 'ADJUST-20260919-MIG-LERMA', '[실사마이그레이션] 실사 재고 정규 주입'
  FROM _stage_direct_stock WHERE lerma > 0;

  INSERT INTO public.stock_transactions (
    transaction_type, item_id, warehouse_code, box_qty, unit_qty, handler_name, invoice_no, memo
  )
  SELECT 'ADJUST', item_id, 'PINO', pino, 0, 'MIGRATION', 'ADJUST-20260919-MIG-PINO', '[실사마이그레이션] 실사 재고 정규 주입'
  FROM _stage_direct_stock WHERE pino > 0;

  INSERT INTO public.stock_transactions (
    transaction_type, item_id, warehouse_code, box_qty, unit_qty, handler_name, invoice_no, memo
  )
  SELECT 'ADJUST', item_id, 'TLANE', tlane, 0, 'MIGRATION', 'ADJUST-20260919-MIG-TLANE', '[실사마이그레이션] 실사 재고 정규 주입'
  FROM _stage_direct_stock WHERE tlane > 0;

  -- 6. 수량 일치 전수 검증 (Assertion)
  SELECT COALESCE(SUM(box_qty), 0) INTO v_p_count FROM public.inventory_stocks WHERE warehouse_code = 'PANTACO';
  SELECT COALESCE(SUM(box_qty), 0) INTO v_i_count FROM public.inventory_stocks WHERE warehouse_code = 'IKEA';
  SELECT COALESCE(SUM(box_qty), 0) INTO v_l_count FROM public.inventory_stocks WHERE warehouse_code = 'LERMA';
  SELECT COALESCE(SUM(box_qty), 0) INTO v_pino_count FROM public.inventory_stocks WHERE warehouse_code = 'PINO';
  SELECT COALESCE(SUM(box_qty), 0) INTO v_t_count FROM public.inventory_stocks WHERE warehouse_code = 'TLANE';
  v_grand_total := v_p_count + v_i_count + v_l_count + v_pino_count + v_t_count;

  IF v_p_count <> 4599 THEN
    RAISE EXCEPTION 'PANTACO 수량 불일치: 실제 % vs 예상 4599', v_p_count;
  END IF;
  IF v_i_count <> 5925 THEN
    RAISE EXCEPTION 'IKEA 수량 불일치: 실제 % vs 예상 5925', v_i_count;
  END IF;
  IF v_l_count <> 414 THEN
    RAISE EXCEPTION 'LERMA 수량 불일치: 실제 % vs 예상 414', v_l_count;
  END IF;
  IF v_pino_count <> 2095 THEN
    RAISE EXCEPTION 'PINO 수량 불일치: 실제 % vs 예상 2095', v_pino_count;
  END IF;
  IF v_t_count <> 2275 THEN
    RAISE EXCEPTION 'TLANE 수량 불일치: 실제 % vs 예상 2275', v_t_count;
  END IF;
  IF v_grand_total <> 15308 THEN
    RAISE EXCEPTION '총계 불일치: 실제 % vs 예상 15308', v_grand_total;
  END IF;

  RAISE NOTICE '✅ 5대 서브창고 실사 마이그레이션 성공! 총 %상자 (PANTACO:%, IKEA:%, LERMA:%, PINO:%, TLANE:%)',
    v_grand_total, v_p_count, v_i_count, v_l_count, v_pino_count, v_t_count;
END $$;
